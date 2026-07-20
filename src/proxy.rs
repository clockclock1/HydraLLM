use crate::{
    auth,
    config::{target_label, upstream_url, Config, FailoverStrategy, ModelConfig, TargetConfig},
    stats::{now_ms, FailureInfo, LogEntry, StatsStore},
    AppState,
};
use axum::{
    body::{Body, Bytes},
    extract::{OriginalUri, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use dashmap::DashMap;
use futures_util::{Stream, StreamExt};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    convert::Infallible,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering as AtomicOrdering},
        Arc,
    },
    time::Duration,
};

#[derive(Debug, thiserror::Error)]
enum ProxyCallError {
    #[error("timeout")]
    Timeout,
    #[error(transparent)]
    Request(#[from] reqwest::Error),
}

impl ProxyCallError {
    fn is_timeout(&self) -> bool {
        match self {
            Self::Timeout => true,
            Self::Request(err) => err.is_timeout(),
        }
    }
}

#[derive(Clone, Default)]
pub struct ProxyRuntime {
    round_robin: Arc<DashMap<String, AtomicU64>>,
    active_threads: Arc<DashMap<String, ActiveThread>>,
    thread_seq: Arc<AtomicU64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ActiveThread {
    pub id: String,
    pub slot: usize,
    pub chain_name: String,
    pub requested_model: String,
    pub target_name: String,
    pub target_model: String,
    pub target_base_url: String,
    pub attempt: u32,
    pub max_attempts: u32,
    pub phase: String,
    pub status: String,
    pub started_at: u64,
    pub updated_at: u64,
    pub release_at: u64,
    pub failed_models: Vec<String>,
    pub attempt_errors: Vec<AttemptError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AttemptError {
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub struct ProxySlot {
    runtime: ProxyRuntime,
    thread_id: Option<String>,
}

pub struct StreamSlotGuard {
    runtime: ProxyRuntime,
    thread_id: Option<String>,
}

impl ProxyRuntime {
    pub async fn acquire(&self, model: &ModelConfig, requested_model: &str) -> ProxySlot {
        let id = format!(
            "thread-{}",
            self.thread_seq.fetch_add(1, AtomicOrdering::Relaxed) + 1
        );
        let now = now_ms();
        self.active_threads.insert(
            id.clone(),
            ActiveThread {
                id: id.clone(),
                slot: self.active_threads.len() + 1,
                chain_name: model.public_name.clone(),
                requested_model: requested_model.to_string(),
                phase: "starting".to_string(),
                status: "线程已创建，等待尝试目标模型".to_string(),
                started_at: now,
                updated_at: now,
                failed_models: Vec::new(),
                attempt_errors: Vec::new(),
                ..ActiveThread::default()
            },
        );
        tracing::info!(thread_id = %id, chain = %model.public_name, "proxy thread created");
        ProxySlot {
            runtime: self.clone(),
            thread_id: Some(id),
        }
    }

    pub fn snapshot_threads(&self) -> Vec<ActiveThread> {
        let mut threads = self
            .active_threads
            .iter()
            .map(|entry| entry.value().clone())
            .collect::<Vec<_>>();
        threads.sort_by_key(|thread| thread.started_at);
        threads
    }

    pub fn update_thread<F>(&self, thread_id: &str, f: F)
    where
        F: FnOnce(&mut ActiveThread),
    {
        if let Some(mut thread) = self.active_threads.get_mut(thread_id) {
            f(&mut thread);
            thread.updated_at = now_ms();
        }
    }

    pub fn append_error(&self, thread_id: &str, error: AttemptError) {
        self.update_thread(thread_id, |thread| {
            thread.attempt_errors.push(error);
            if thread.attempt_errors.len() > 32 {
                let drain_to = thread.attempt_errors.len() - 32;
                thread.attempt_errors.drain(0..drain_to);
            }
        });
    }

    pub fn retain_round_robin_models<I>(&self, model_names: I)
    where
        I: IntoIterator,
        I::Item: AsRef<str>,
    {
        let valid = model_names
            .into_iter()
            .map(|name| name.as_ref().to_string())
            .collect::<HashSet<_>>();
        let stale = self
            .round_robin
            .iter()
            .filter_map(|entry| {
                if valid.contains(entry.key()) {
                    None
                } else {
                    Some(entry.key().clone())
                }
            })
            .collect::<Vec<_>>();
        for key in stale {
            self.round_robin.remove(&key);
        }
    }
}

impl Drop for ProxySlot {
    fn drop(&mut self) {
        if let Some(thread_id) = self.thread_id.take() {
            release_proxy_slot(self.runtime.clone(), thread_id);
        }
    }
}

impl ProxySlot {
    fn into_stream_guard(mut self) -> StreamSlotGuard {
        StreamSlotGuard {
            runtime: self.runtime.clone(),
            thread_id: self.thread_id.take(),
        }
    }
}

impl Drop for StreamSlotGuard {
    fn drop(&mut self) {
        if let Some(thread_id) = self.thread_id.take() {
            release_proxy_slot(self.runtime.clone(), thread_id);
        }
    }
}

fn release_proxy_slot(runtime: ProxyRuntime, thread_id: String) {
    tracing::info!(thread_id = %thread_id, "proxy thread removed");
    runtime.active_threads.remove(&thread_id);
}

pub async fn list_models(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let cfg = state.config.read().await.clone();
    if !auth::is_proxy_key(&headers, &cfg) {
        return send_error(StatusCode::UNAUTHORIZED, "Invalid proxy API key", None);
    }
    let now = (now_ms() / 1000) as u64;
    let models = state.model_source.runtime_models(&cfg).await;
    Json(json!({
        "object": "list",
        "data": models.into_iter().map(|model| json!({
            "id": model.public_name,
            "object": "model",
            "created": now,
            "owned_by": "failover-proxy"
        })).collect::<Vec<_>>()
    }))
    .into_response()
}

pub async fn proxy_endpoint(
    State(state): State<AppState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    body: Bytes,
) -> Response {
    proxy_completion(state, headers, uri.path().to_string(), body).await
}

async fn proxy_completion(
    state: AppState,
    headers: HeaderMap,
    pathname: String,
    body_bytes: Bytes,
) -> Response {
    let cfg = state.config.read().await.clone();
    if !auth::is_proxy_key(&headers, &cfg) {
        return send_error(StatusCode::UNAUTHORIZED, "Invalid proxy API key", None);
    }
    let mut body: Value = match serde_json::from_slice(&body_bytes) {
        Ok(value) => value,
        Err(err) => return send_error(StatusCode::BAD_REQUEST, &err.to_string(), None),
    };
    if !body.is_object() {
        return send_error(StatusCode::BAD_REQUEST, "Invalid JSON body", None);
    }
    let requested_model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let Some(model) = state.model_source.find_model(&cfg, &requested_model).await else {
        return send_error(
            StatusCode::NOT_FOUND,
            &format!("Model '{}' is not configured", requested_model),
            None,
        );
    };
    let targets = enabled_targets(&state, &cfg, &model).await;
    if targets.is_empty() {
        return send_error(
            StatusCode::SERVICE_UNAVAILABLE,
            &format!("Model '{}' has no enabled targets", requested_model),
            None,
        );
    }
    let slot = state.proxy_runtime.acquire(&model, &requested_model).await;
    let thread_id = slot.thread_id.as_deref().unwrap_or_default().to_string();
    let response = proxy_loop(
        &state,
        &headers,
        &pathname,
        &mut body,
        &cfg,
        &model,
        targets,
        &requested_model,
        &thread_id,
        slot,
    )
    .await;
    response
}

async fn proxy_loop(
    state: &AppState,
    headers: &HeaderMap,
    pathname: &str,
    body: &mut Value,
    cfg: &Config,
    model: &ModelConfig,
    targets: Vec<TargetConfig>,
    requested_model: &str,
    thread_id: &str,
    _slot: ProxySlot,
) -> Response {
    state.stats.chain_request(&model.public_name).await;
    let started_at = now_ms();
    let is_stream = body.get("stream").and_then(Value::as_bool) == Some(true);
    let mut errors: Vec<AttemptError> = Vec::new();
    let mut failed_models: Vec<String> = Vec::new();

    for target in targets {
        if state
            .circuit_breakers
            .is_open_and_cleanup(model, &target, &state.stats)
            .await
        {
            let label = target_label(&target);
            let err = AttemptError {
                target: label.clone(),
                message: "circuit open".to_string(),
                ..AttemptError::default()
            };
            state.proxy_runtime.append_error(thread_id, err.clone());
            state.proxy_runtime.update_thread(thread_id, |thread| {
                thread.target_name = target.name.clone();
                thread.target_model = target.model_name.clone();
                thread.target_base_url = target.base_url.clone();
                thread.phase = "skipped".to_string();
                thread.status = "目标处于熔断冷却状态，已跳过".to_string();
                let mut next = failed_models.clone();
                next.push(label.clone());
                thread.failed_models = next;
            });
            errors.push(err);
            failed_models.push(label);
            continue;
        }

        let max_attempts = 1 + target.max_retries;
        for attempt in 1..=max_attempts {
            if state.circuit_breakers.is_open(model, &target) {
                let label = target_label(&target);
                let err = AttemptError {
                    target: label.clone(),
                    attempt: Some(attempt),
                    message: "circuit open".to_string(),
                    ..AttemptError::default()
                };
                state.proxy_runtime.append_error(thread_id, err.clone());
                state.proxy_runtime.update_thread(thread_id, |thread| {
                    thread.target_name = target.name.clone();
                    thread.target_model = target.model_name.clone();
                    thread.target_base_url = target.base_url.clone();
                    thread.attempt = attempt;
                    thread.max_attempts = max_attempts;
                    thread.phase = "skipped".to_string();
                    thread.status = "目标在重试前进入熔断冷却状态，已跳过".to_string();
                    let mut next = failed_models.clone();
                    next.push(label.clone());
                    thread.failed_models = next;
                });
                errors.push(err);
                failed_models.push(label);
                break;
            }

            let label = target_label(&target);
            let target_started = now_ms();
            state.proxy_runtime.update_thread(thread_id, |thread| {
                thread.target_name = target.name.clone();
                thread.target_model = target.model_name.clone();
                thread.target_base_url = target.base_url.clone();
                thread.attempt = attempt;
                thread.max_attempts = max_attempts;
                thread.phase = "calling".to_string();
                thread.status = format!("正在请求 {} (第 {}/{})", label, attempt, max_attempts);
                thread.failed_models = failed_models.clone();
            });

            let upstream = match call_target(
                &state.client,
                headers,
                pathname,
                body,
                &target,
                cfg,
                is_stream,
            )
            .await
            {
                Ok(upstream) => upstream,
                Err(err) => {
                    let failure = FailureInfo {
                        message: if err.is_timeout() {
                            "timeout".to_string()
                        } else {
                            err.to_string()
                        },
                        ..FailureInfo::default()
                    };
                    state
                        .circuit_breakers
                        .record_failure(
                            model,
                            &target,
                            cfg,
                            &state.stats,
                            failure.clone(),
                            now_ms().saturating_sub(target_started),
                        )
                        .await;
                    let err_item = AttemptError {
                        target: label.clone(),
                        attempt: Some(attempt),
                        message: failure.message.clone(),
                        ..AttemptError::default()
                    };
                    state
                        .proxy_runtime
                        .append_error(thread_id, err_item.clone());
                    state.proxy_runtime.update_thread(thread_id, |thread| {
                        thread.phase =
                            if should_retry_target(&failure, cfg, attempt, max_attempts, model) {
                                "retrying"
                            } else {
                                "failed-target"
                            }
                            .to_string();
                        thread.status = format!("{} 请求失败：{}", label, failure.message);
                    });
                    errors.push(err_item);
                    if should_retry_target(&failure, cfg, attempt, max_attempts, model) {
                        continue;
                    }
                    failed_models.push(label);
                    break;
                }
            };

            let status = upstream.status();
            let response_type = upstream
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    if is_stream {
                        "text/event-stream"
                    } else {
                        "application/json"
                    }
                    .to_string()
                });

            if !status.is_success() {
                let text = upstream.text().await.unwrap_or_default();
                let failure = classify_upstream_failure(status.as_u16(), &text, false, false)
                    .unwrap_or_else(|| FailureInfo {
                        status: status.as_u16(),
                        message: format!("Upstream returned {}", status.as_u16()),
                        body: trim_error(&text),
                    });
                state
                    .circuit_breakers
                    .record_failure(
                        model,
                        &target,
                        cfg,
                        &state.stats,
                        failure.clone(),
                        now_ms().saturating_sub(target_started),
                    )
                    .await;
                let err_item = AttemptError {
                    target: label.clone(),
                    attempt: Some(attempt),
                    status: Some(failure.status),
                    message: if failure.message.is_empty() {
                        format!("Upstream returned {}", status.as_u16())
                    } else {
                        failure.message.clone()
                    },
                    detail: Some(if failure.body.is_empty() {
                        trim_error(&text)
                    } else {
                        failure.body.clone()
                    }),
                };
                state
                    .proxy_runtime
                    .append_error(thread_id, err_item.clone());
                state.proxy_runtime.update_thread(thread_id, |thread| {
                    thread.phase =
                        if should_retry_target(&failure, cfg, attempt, max_attempts, model) {
                            "retrying"
                        } else {
                            "failed-target"
                        }
                        .to_string();
                    thread.status = format!(
                        "{} 返回 HTTP {}",
                        label,
                        failure.status.max(status.as_u16())
                    );
                });
                errors.push(err_item);
                if should_retry_target(&failure, cfg, attempt, max_attempts, model) {
                    continue;
                }
                failed_models.push(label);
                if should_try_next(failure.status.max(status.as_u16()), cfg) {
                    break;
                }
                state.stats.chain_failure(&model.public_name).await;
                log_request(
                    &state.stats,
                    model,
                    requested_model,
                    &failed_models,
                    "",
                    "failed",
                    started_at,
                    &failure.message,
                )
                .await;
                return raw_response(status, response_type, text, None);
            }

            if !is_stream {
                let text = upstream.text().await.unwrap_or_default();
                if let Some(failure) = classify_upstream_failure(status.as_u16(), &text, true, true)
                {
                    state
                        .circuit_breakers
                        .record_failure(
                            model,
                            &target,
                            cfg,
                            &state.stats,
                            failure.clone(),
                            now_ms().saturating_sub(target_started),
                        )
                        .await;
                    let err_item = AttemptError {
                        target: label.clone(),
                        attempt: Some(attempt),
                        status: Some(failure.status),
                        message: failure.message.clone(),
                        detail: Some(failure.body.clone()),
                    };
                    state
                        .proxy_runtime
                        .append_error(thread_id, err_item.clone());
                    state.proxy_runtime.update_thread(thread_id, |thread| {
                        thread.phase =
                            if should_retry_target(&failure, cfg, attempt, max_attempts, model) {
                                "retrying"
                            } else {
                                "failed-target"
                            }
                            .to_string();
                        thread.status = format!("{} 响应内容校验失败：{}", label, failure.message);
                    });
                    errors.push(err_item);
                    if should_retry_target(&failure, cfg, attempt, max_attempts, model) {
                        continue;
                    }
                    failed_models.push(label);
                    if should_try_next(failure.status, cfg) {
                        break;
                    }
                    state.stats.chain_failure(&model.public_name).await;
                    log_request(
                        &state.stats,
                        model,
                        requested_model,
                        &failed_models,
                        "",
                        "failed",
                        started_at,
                        &failure.message,
                    )
                    .await;
                    return raw_response(
                        StatusCode::from_u16(failure.status).unwrap_or(StatusCode::BAD_GATEWAY),
                        response_type,
                        text,
                        None,
                    );
                }

                state
                    .circuit_breakers
                    .record_success(
                        model,
                        &target,
                        cfg,
                        &state.stats,
                        now_ms().saturating_sub(target_started),
                    )
                    .await;
                state
                    .stats
                    .chain_success(&model.public_name, !failed_models.is_empty())
                    .await;
                state.proxy_runtime.update_thread(thread_id, |thread| {
                    thread.phase = "completed".to_string();
                    thread.status = format!("已完成来自 {} 的非流式响应", label);
                    thread.failed_models = failed_models.clone();
                });
                log_request(
                    &state.stats,
                    model,
                    requested_model,
                    &failed_models,
                    &label,
                    "success",
                    started_at,
                    &errors
                        .iter()
                        .map(format_attempt_error)
                        .collect::<Vec<_>>()
                        .join(", "),
                )
                .await;
                return raw_response(
                    status,
                    response_type,
                    text,
                    Some((&target.name, &target.model_name)),
                );
            }

            let inspected = match tokio::time::timeout(
                target_timeout(&target, cfg),
                inspect_initial_stream(upstream, status.as_u16()),
            )
            .await
            {
                Ok(result) => result,
                Err(_) => Err(anyhow::anyhow!("timeout")),
            };
            let inspected = match inspected {
                Ok(v) => v,
                Err(err) => {
                    let failure = FailureInfo {
                        message: err.to_string(),
                        ..FailureInfo::default()
                    };
                    state
                        .circuit_breakers
                        .record_failure(
                            model,
                            &target,
                            cfg,
                            &state.stats,
                            failure.clone(),
                            now_ms().saturating_sub(target_started),
                        )
                        .await;
                    let err_item = AttemptError {
                        target: label.clone(),
                        attempt: Some(attempt),
                        message: failure.message.clone(),
                        ..AttemptError::default()
                    };
                    state
                        .proxy_runtime
                        .append_error(thread_id, err_item.clone());
                    errors.push(err_item);
                    if should_retry_target(&failure, cfg, attempt, max_attempts, model) {
                        continue;
                    }
                    failed_models.push(label);
                    break;
                }
            };

            if let Some(failure) = inspected.failure {
                state
                    .circuit_breakers
                    .record_failure(
                        model,
                        &target,
                        cfg,
                        &state.stats,
                        failure.clone(),
                        now_ms().saturating_sub(target_started),
                    )
                    .await;
                let err_item = AttemptError {
                    target: label.clone(),
                    attempt: Some(attempt),
                    status: Some(failure.status),
                    message: failure.message.clone(),
                    detail: Some(failure.body.clone()),
                };
                state
                    .proxy_runtime
                    .append_error(thread_id, err_item.clone());
                state.proxy_runtime.update_thread(thread_id, |thread| {
                    thread.phase =
                        if should_retry_target(&failure, cfg, attempt, max_attempts, model) {
                            "retrying"
                        } else {
                            "failed-target"
                        }
                        .to_string();
                    thread.status = format!("{} 初始流检测失败：{}", label, failure.message);
                });
                errors.push(err_item);
                if should_retry_target(&failure, cfg, attempt, max_attempts, model) {
                    continue;
                }
                failed_models.push(label);
                if should_try_next(failure.status, cfg) {
                    break;
                }
                state.stats.chain_failure(&model.public_name).await;
                log_request(
                    &state.stats,
                    model,
                    requested_model,
                    &failed_models,
                    "",
                    "failed",
                    started_at,
                    &failure.message,
                )
                .await;
                return send_error(
                    StatusCode::from_u16(failure.status).unwrap_or(StatusCode::BAD_GATEWAY),
                    &failure.message,
                    None,
                );
            }

            state.proxy_runtime.update_thread(thread_id, |thread| {
                thread.phase = "streaming".to_string();
                thread.status = format!("正在流式转发 {}", label);
                thread.failed_models = failed_models.clone();
            });
            tracing::info!(thread_id = %thread_id, target = %label, "proxy thread streaming");
            return stream_response(
                state.clone(),
                model.clone(),
                target.clone(),
                cfg.clone(),
                thread_id.to_string(),
                requested_model.to_string(),
                failed_models.clone(),
                label,
                started_at,
                target_started,
                status,
                response_type,
                inspected,
                !failed_models.is_empty(),
                _slot.into_stream_guard(),
            );
        }
    }

    state.stats.chain_failure(&model.public_name).await;
    state.proxy_runtime.update_thread(thread_id, |thread| {
        thread.phase = "failed".to_string();
        thread.status = "所有配置的目标模型均失败".to_string();
        thread.failed_models = failed_models.clone();
    });
    let detail = json!(errors);
    let error_text = errors
        .iter()
        .map(format_attempt_error)
        .collect::<Vec<_>>()
        .join(", ");
    log_request(
        &state.stats,
        model,
        requested_model,
        &failed_models,
        "",
        "failed",
        started_at,
        &error_text,
    )
    .await;
    send_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "All configured targets failed before a response could be returned",
        Some(detail),
    )
}

async fn enabled_targets(state: &AppState, cfg: &Config, model: &ModelConfig) -> Vec<TargetConfig> {
    let configured = model
        .targets
        .iter()
        .filter(|target| {
            target.enabled && !target.base_url.is_empty() && !target.api_key.is_empty()
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut available = Vec::new();
    for target in &configured {
        if !state
            .circuit_breakers
            .is_open_and_cleanup(model, target, &state.stats)
            .await
        {
            available.push(target.clone());
        }
    }
    let selected = if configured.is_empty() || !available.is_empty() {
        available
    } else {
        state
            .circuit_breakers
            .reset_model(model, &state.stats)
            .await;
        configured
    };
    select_target_queue(state, cfg, model, selected).await
}

async fn select_target_queue(
    state: &AppState,
    _cfg: &Config,
    model: &ModelConfig,
    mut targets: Vec<TargetConfig>,
) -> Vec<TargetConfig> {
    targets.sort_by_key(|target| target.priority);
    if targets.len() <= 1 {
        return targets;
    }
    match model.strategy {
        FailoverStrategy::RoundRobin => {
            let cursor = state
                .proxy_runtime
                .round_robin
                .entry(model.public_name.clone())
                .or_insert_with(|| AtomicU64::new(0))
                .fetch_add(1, AtomicOrdering::Relaxed) as usize;
            rotate_targets(targets, cursor)
        }
        FailoverStrategy::Weighted => {
            let total: u32 = targets.iter().map(|target| target.weight.max(1)).sum();
            let mut ticket = rand::random::<f64>() * total as f64;
            let start = targets
                .iter()
                .position(|target| {
                    ticket -= target.weight.max(1) as f64;
                    ticket <= 0.0
                })
                .unwrap_or(0);
            rotate_targets(targets, start)
        }
        FailoverStrategy::LatencyBased => {
            let mut scored = Vec::with_capacity(targets.len());
            for target in targets {
                let latency = state.stats.avg_latency(model, &target).await;
                scored.push((target, latency));
            }
            scored.sort_by(|(a, la), (b, lb)| {
                let aa = if *la == 0 { u64::MAX } else { *la };
                let bb = if *lb == 0 { u64::MAX } else { *lb };
                aa.cmp(&bb).then_with(|| a.priority.cmp(&b.priority))
            });
            scored.into_iter().map(|(target, _)| target).collect()
        }
        FailoverStrategy::Priority => targets,
    }
}

fn rotate_targets(mut targets: Vec<TargetConfig>, start: usize) -> Vec<TargetConfig> {
    if targets.is_empty() {
        return targets;
    }
    let idx = start % targets.len();
    targets.rotate_left(idx);
    targets
}

async fn call_target(
    client: &Client,
    inbound_headers: &HeaderMap,
    pathname: &str,
    body: &Value,
    target: &TargetConfig,
    cfg: &Config,
    is_stream: bool,
) -> Result<reqwest::Response, ProxyCallError> {
    let mut next_body = body.clone();
    if let Some(obj) = next_body.as_object_mut() {
        obj.insert(
            "model".to_string(),
            Value::String(if target.model_name.is_empty() {
                body.get("model")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            } else {
                target.model_name.clone()
            }),
        );
    }
    let mut req = client
        .post(upstream_url(target, pathname))
        .header(header::CONTENT_TYPE, "application/json")
        .bearer_auth(&target.api_key)
        .body(serde_json::to_vec(&next_body).unwrap_or_default());
    if let Some(value) = inbound_headers.get("openai-organization") {
        req = req.header("openai-organization", value);
    }
    if let Some(value) = inbound_headers.get("openai-project") {
        req = req.header("openai-project", value);
    }
    let timeout = target_timeout(target, cfg);
    if is_stream {
        match tokio::time::timeout(timeout, req.send()).await {
            Ok(result) => Ok(result?),
            Err(_) => Err(ProxyCallError::Timeout),
        }
    } else {
        Ok(req.timeout(timeout).send().await?)
    }
}

fn target_timeout(target: &TargetConfig, cfg: &Config) -> Duration {
    Duration::from_millis(if target.timeout_ms == 0 {
        cfg.request_timeout_ms
    } else {
        target.timeout_ms
    })
}

#[derive(Default)]
struct StreamInspection {
    chunks: Vec<Bytes>,
    stream: Option<Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>>,
    failure: Option<FailureInfo>,
}

async fn inspect_initial_stream(
    upstream: reqwest::Response,
    status: u16,
) -> anyhow::Result<StreamInspection> {
    let ok = upstream.status().is_success();
    let mut stream: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>> =
        Box::pin(upstream.bytes_stream());
    let mut chunks = Vec::new();
    let mut text = String::new();
    while text.len() < stream_probe_bytes() {
        match stream.next().await {
            Some(Ok(chunk)) => {
                text.push_str(&String::from_utf8_lossy(&chunk));
                chunks.push(chunk);
                if let Some(failure) = classify_upstream_failure(status, &text, ok, false) {
                    return Ok(StreamInspection {
                        chunks,
                        stream: Some(stream),
                        failure: Some(failure),
                    });
                }
                if stream_probe_complete(&text) {
                    return Ok(StreamInspection {
                        chunks,
                        stream: Some(stream),
                        failure: None,
                    });
                }
            }
            Some(Err(err)) => return Err(err.into()),
            None => {
                if let Some(failure) = classify_upstream_failure(status, &text, ok, false) {
                    return Ok(StreamInspection {
                        chunks,
                        stream: None,
                        failure: Some(failure),
                    });
                }
                return Ok(StreamInspection {
                    chunks,
                    stream: None,
                    failure: None,
                });
            }
        }
    }
    Ok(StreamInspection {
        chunks,
        stream: Some(stream),
        failure: None,
    })
}

#[allow(clippy::too_many_arguments)]
fn stream_response(
    state: AppState,
    model: ModelConfig,
    target: TargetConfig,
    cfg: Config,
    thread_id: String,
    requested_model: String,
    failed_models: Vec<String>,
    label: String,
    started_at: u64,
    target_started: u64,
    status: StatusCode,
    response_type: String,
    mut inspected: StreamInspection,
    failover: bool,
    slot: StreamSlotGuard,
) -> Response {
    let response_target_name = target.name.clone();
    let response_model_name = target.model_name.clone();
    let body_stream = async_stream::stream! {
        let slot_guard = slot;
        let mut stream_failure = None;
        for chunk in inspected.chunks.drain(..) {
            yield Ok::<Bytes, Infallible>(chunk);
        }
        if let Some(mut stream) = inspected.stream {
            while let Some(item) = stream.next().await {
                match item {
                    Ok(chunk) => {
                        yield Ok::<Bytes, Infallible>(chunk);
                    }
                    Err(err) => {
                        stream_failure = Some(FailureInfo {
                            message: err.to_string(),
                            ..FailureInfo::default()
                        });
                        break;
                    }
                }
            }
        }
        if let Some(failure) = stream_failure {
            state
                .circuit_breakers
                .record_failure(
                    &model,
                    &target,
                    &cfg,
                    &state.stats,
                    failure.clone(),
                    now_ms().saturating_sub(target_started),
                )
                .await;
            let mut stream_failed_models = failed_models.clone();
            stream_failed_models.push(label.clone());
            state.proxy_runtime.append_error(
                &thread_id,
                AttemptError {
                    target: label.clone(),
                    status: Some(failure.status),
                    message: failure.message.clone(),
                    detail: Some(failure.body.clone()),
                    ..AttemptError::default()
                },
            );
            state.proxy_runtime.update_thread(&thread_id, |thread| {
                thread.phase = "failed".to_string();
                thread.status = format!("流式响应中检测到失败：{}", failure.message);
                thread.failed_models = stream_failed_models.clone();
            });
            state.stats.chain_failure(&model.public_name).await;
            log_request(
                &state.stats,
                &model,
                &requested_model,
                &stream_failed_models,
                "",
                "failed",
                started_at,
                &failure.message,
            )
            .await;
        } else {
            state
                .circuit_breakers
                .record_success(
                    &model,
                    &target,
                    &cfg,
                    &state.stats,
                    now_ms().saturating_sub(target_started),
                )
                .await;
            state
                .stats
                .chain_success(&model.public_name, failover)
                .await;
            state.proxy_runtime.update_thread(&thread_id, |thread| {
                thread.phase = "completed".to_string();
                thread.status = format!("已完成来自 {} 的流式响应", label);
                thread.failed_models = failed_models.clone();
            });
            log_request(
                &state.stats,
                &model,
                &requested_model,
                &failed_models,
                &label,
                "success",
                started_at,
                "",
            )
            .await;
        }
        drop(slot_guard);
    };
    let mut response = Response::new(Body::from_stream(body_stream));
    *response.status_mut() = status;
    insert_common_proxy_headers(
        response.headers_mut(),
        &response_type,
        &response_target_name,
        &response_model_name,
        true,
    );
    response
}

pub fn classify_upstream_failure(
    status: u16,
    text: &str,
    response_ok: bool,
    validate_empty_output: bool,
) -> Option<FailureInfo> {
    let embedded = embedded_error(parse_json_safe(text).as_ref(), text)
        .or_else(|| embedded_stream_error(text));
    if !response_ok {
        return Some(FailureInfo {
            status,
            message: embedded
                .as_ref()
                .map(|e| e.message.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("Upstream returned {}", status)),
            body: trim_error(text),
        });
    }
    if let Some(err) = embedded {
        return Some(err);
    }
    if validate_empty_output {
        return validate_assistant_output(text);
    }
    None
}

fn parse_json_safe(text: &str) -> Option<Value> {
    if text.is_empty() {
        None
    } else {
        serde_json::from_str(text).ok()
    }
}

fn embedded_error(payload: Option<&Value>, text: &str) -> Option<FailureInfo> {
    let payload = payload?;
    let has_explicit_error = payload.get("error").is_some()
        || payload.get("error_message").is_some()
        || payload.get("status_code").is_some();
    let error = payload
        .get("error")
        .or_else(|| payload.pointer("/detail/error"))
        .or_else(|| payload.pointer("/details/error"));
    let mut candidates = Vec::new();
    if let Some(err) = error {
        if let Some(s) = err.as_str() {
            candidates.push(s.to_string());
        }
        if let Some(s) = err.get("message").and_then(Value::as_str) {
            candidates.push(s.to_string());
        }
        if let Some(s) = err.get("details").and_then(Value::as_str) {
            candidates.push(s.to_string());
        }
    }
    if has_explicit_error {
        if let Some(s) = payload.get("message").and_then(Value::as_str) {
            candidates.push(s.to_string());
        }
    }
    if let Some(s) = payload.get("detail").and_then(Value::as_str) {
        candidates.push(s.to_string());
    }
    if let Some(s) = payload.get("error_message").and_then(Value::as_str) {
        candidates.push(s.to_string());
    }
    let message = candidates
        .into_iter()
        .find(|item| !item.trim().is_empty())
        .unwrap_or_default();
    let raw_status = error
        .and_then(|err| {
            err.get("status")
                .or_else(|| err.get("status_code"))
                .or_else(|| err.get("code"))
        })
        .or_else(|| payload.get("status"))
        .or_else(|| payload.get("status_code"));
    let numeric = raw_status
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str()?.parse::<u64>().ok())
        })
        .unwrap_or(0) as u16;
    let regex_status = regex::Regex::new(r"(?i)\b(?:returned|status|code|http)\s*:?\s*(\d{3})\b")
        .ok()
        .and_then(|re| {
            re.captures(text)
                .and_then(|cap| cap.get(1))
                .and_then(|m| m.as_str().parse::<u16>().ok())
        })
        .unwrap_or(0);
    let status = if numeric >= 400 {
        numeric
    } else {
        regex_status
    };
    if !message.is_empty() || status >= 400 {
        Some(FailureInfo {
            status: if status >= 400 { status } else { 0 },
            message: if !message.is_empty() {
                message
            } else {
                format!("Upstream returned {}", status)
            },
            body: trim_error(text),
        })
    } else {
        None
    }
}

fn embedded_stream_error(text: &str) -> Option<FailureInfo> {
    for event in parse_sse_data_payloads(text) {
        if let Some(payload) = parse_json_safe(&event) {
            if let Some(err) = embedded_error(Some(&payload), &event) {
                return Some(err);
            }
        }
    }
    None
}

pub fn parse_sse_data_payloads(text: &str) -> Vec<String> {
    let mut events = Vec::new();
    let mut current = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            if !current.is_empty() {
                events.push(current.join("\n"));
                current.clear();
            }
        } else if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim_start();
            if !data.is_empty() && data != "[DONE]" {
                current.push(data.to_string());
            }
        }
    }
    if !current.is_empty() {
        events.push(current.join("\n"));
    }
    events
}

fn validate_assistant_output(text: &str) -> Option<FailureInfo> {
    let payload = parse_json_safe(text)?;
    let assistant = assistant_text(&payload);
    let tool_calls = assistant_tool_calls(&payload);
    let reasoning = assistant_reasoning_text(&payload);
    if assistant.trim().is_empty() && tool_calls.is_empty() && reasoning.trim().is_empty() {
        return Some(FailureInfo {
            status: 502,
            message: "Upstream returned empty assistant output".to_string(),
            body: trim_error(text),
        });
    }
    None
}

fn assistant_text(payload: &Value) -> String {
    if let Some(content) = payload.pointer("/choices/0/message/content") {
        if let Some(s) = content.as_str() {
            return s.to_string();
        }
        if let Some(arr) = content.as_array() {
            return arr
                .iter()
                .filter_map(|item| {
                    item.as_str()
                        .map(str::to_string)
                        .or_else(|| item.get("text").and_then(Value::as_str).map(str::to_string))
                        .or_else(|| {
                            item.get("content")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        })
                })
                .collect::<Vec<_>>()
                .join("\n");
        }
    }
    payload
        .pointer("/choices/0/text")
        .and_then(Value::as_str)
        .or_else(|| payload.get("output_text").and_then(Value::as_str))
        .unwrap_or("")
        .to_string()
}

fn assistant_tool_calls(payload: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(arr) = payload
        .pointer("/choices/0/message/tool_calls")
        .and_then(Value::as_array)
    {
        out.extend(arr.clone());
    }
    if let Some(arr) = payload.get("tool_calls").and_then(Value::as_array) {
        out.extend(arr.clone());
    }
    if let Some(arr) = payload.get("output").and_then(Value::as_array) {
        out.extend(
            arr.iter()
                .filter(|item| {
                    item.get("type")
                        .and_then(Value::as_str)
                        .is_some_and(|kind| kind.contains("tool") || kind.contains("function_call"))
                })
                .cloned(),
        );
    }
    out
}

fn assistant_reasoning_text(payload: &Value) -> String {
    let reasoning = payload
        .pointer("/choices/0/message/reasoning_content")
        .or_else(|| payload.pointer("/choices/0/message/reasoning"));
    if let Some(value) = reasoning {
        if let Some(s) = value.as_str() {
            return s.to_string();
        }
        if let Some(arr) = value.as_array() {
            return arr
                .iter()
                .filter_map(|item| {
                    item.as_str()
                        .map(str::to_string)
                        .or_else(|| item.get("text").and_then(Value::as_str).map(str::to_string))
                        .or_else(|| {
                            item.get("content")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        })
                })
                .collect::<Vec<_>>()
                .join("\n");
        }
    }
    String::new()
}

fn should_try_next(status_code: u16, cfg: &Config) -> bool {
    status_code >= 400 || cfg.failover_status_codes.contains(&status_code)
}

fn should_retry_target(
    failure: &FailureInfo,
    cfg: &Config,
    attempt: u32,
    max_attempts: u32,
    model: &ModelConfig,
) -> bool {
    if attempt >= max_attempts {
        return false;
    }
    if crate::config::model_circuit(model, cfg)
        .immediate_cooldown_status_codes
        .contains(&failure.status)
    {
        return false;
    }
    if failure.status == 0 {
        return true;
    }
    failure.status >= 500 || failure.status == 408 || failure.status == 409
}

pub fn trim_error(text: &str) -> String {
    text.chars().take(1500).collect()
}

fn stream_probe_complete(text: &str) -> bool {
    text.contains("\n\n") || text.contains("\r\n\r\n") || text.len() >= stream_probe_bytes()
}

fn stream_probe_bytes() -> usize {
    std::env::var("STREAM_FAILURE_PROBE_KB")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(64)
        * 1024
}

fn send_error(status: StatusCode, message: &str, details: Option<Value>) -> Response {
    let body = match details {
        Some(details) => {
            json!({ "error": { "message": message, "type": "proxy_error", "details": details } })
        }
        None => json!({ "error": { "message": message, "type": "proxy_error" } }),
    };
    (status, Json(body)).into_response()
}

fn raw_response(
    status: StatusCode,
    response_type: String,
    text: String,
    proxy_headers: Option<(&str, &str)>,
) -> Response {
    let mut response = Response::new(Body::from(text));
    *response.status_mut() = status;
    let (target, model) = proxy_headers.unwrap_or(("", ""));
    insert_common_proxy_headers(response.headers_mut(), &response_type, target, model, false);
    response
}

fn insert_common_proxy_headers(
    headers: &mut HeaderMap,
    response_type: &str,
    target: &str,
    model: &str,
    stream: bool,
) {
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(response_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/json")),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if stream {
            "no-cache, no-transform"
        } else {
            "no-cache"
        }),
    );
    headers.insert(
        "x-proxy-target",
        HeaderValue::from_str(target).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    headers.insert(
        "x-proxy-model",
        HeaderValue::from_str(model).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
}

fn format_attempt_error(item: &AttemptError) -> String {
    let suffix = item.attempt.map(|n| format!("#{}", n)).unwrap_or_default();
    let value = item
        .status
        .map(|s| s.to_string())
        .unwrap_or_else(|| item.message.clone());
    format!(
        "{}{}: {}",
        if item.target.is_empty() {
            "target"
        } else {
            &item.target
        },
        suffix,
        value
    )
}

async fn log_request(
    stats: &StatsStore,
    model: &ModelConfig,
    requested_model: &str,
    failed_models: &[String],
    final_model: &str,
    status: &str,
    started_at: u64,
    error: &str,
) {
    stats
        .add_log(LogEntry {
            chain_name: model.public_name.clone(),
            original_model: requested_model.to_string(),
            failed_models: failed_models.to_vec(),
            final_model: final_model.to_string(),
            status: status.to_string(),
            latency: now_ms().saturating_sub(started_at),
            error: error.to_string(),
            ..LogEntry::default()
        })
        .await;
}
