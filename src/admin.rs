use crate::{
    config::{save_config, Config, ModelConfig},
    model_source::{configured_providers, fetch_model_source, filter_source_models},
    AppState,
};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use bytes::Bytes;
use serde_json::{json, Value};

include!(concat!(env!("OUT_DIR"), "/embedded_assets.rs"));

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let cfg = state.config.read().await.clone();
    let token = body.get("token").and_then(Value::as_str).unwrap_or("");
    if token != cfg.admin_token {
        return send_error(StatusCode::UNAUTHORIZED, "Invalid admin token", None);
    }
    let session = state.auth.create_admin_session();
    let _ = headers;
    Json(json!({ "ok": true, "session": session })).into_response()
}

pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    state.auth.delete_admin_session(&headers);
    Json(json!({ "ok": true })).into_response()
}

pub async fn session(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let cfg = state.config.read().await.clone();
    Json(json!({ "ok": state.auth.is_admin(&headers, &cfg) })).into_response()
}

pub async fn get_config(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let cfg = state.config.read().await.clone();
    if !state.auth.is_admin(&headers, &cfg) {
        return send_error(StatusCode::UNAUTHORIZED, "Invalid admin token", None);
    }
    Json(cfg).into_response()
}

pub async fn post_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(next_config): Json<Config>,
) -> Response {
    let cfg = state.config.read().await.clone();
    if !state.auth.is_admin(&headers, &cfg) {
        return send_error(StatusCode::UNAUTHORIZED, "Invalid admin token", None);
    }
    match save_config(&state.config_path, &next_config).await {
        Ok(normalized) => {
            *state.config.write().await = normalized.clone();
            let mut runtime_models = normalized.models.clone();
            runtime_models.extend(state.model_source.cached_models().await);
            cleanup_runtime_state(&state, &runtime_models).await;
            Json(json!({ "ok": true, "config": normalized })).into_response()
        }
        Err(err) => send_error(StatusCode::BAD_REQUEST, &err.to_string(), None),
    }
}

pub async fn get_stats(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let cfg = state.config.read().await.clone();
    if !state.auth.is_admin(&headers, &cfg) {
        return send_error(StatusCode::UNAUTHORIZED, "Invalid admin token", None);
    }
    let mut value =
        serde_json::to_value(state.stats.snapshot().await).unwrap_or_else(|_| json!({}));
    value["activeThreads"] = json!(state.proxy_runtime.snapshot_threads());
    value["memory"] = process_memory();
    Json(value).into_response()
}

pub async fn get_page_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(page): Path<String>,
) -> Response {
    let cfg = state.config.read().await.clone();
    if !state.auth.is_admin(&headers, &cfg) {
        return send_error(StatusCode::UNAUTHORIZED, "Invalid admin token", None);
    }

    let value = match page.as_str() {
        "dashboard" => {
            let stats = state.stats.snapshot().await;
            json!({
                "startedAt": stats.started_at,
                "requests": stats.requests,
                "successes": stats.successes,
                "failures": stats.failures,
                "failovers": stats.failovers,
                "chains": stats.chains,
                "logs": stats.logs.into_iter().take(10).collect::<Vec<_>>(),
            })
        }
        "chains" => {
            let stats = state.stats.snapshot().await;
            json!({
                "requests": stats.requests,
                "successes": stats.successes,
                "failures": stats.failures,
                "failovers": stats.failovers,
                "chains": stats.chains,
            })
        }
        "model-stats" => {
            let stats = state.stats.snapshot().await;
            json!({
                "requests": stats.requests,
                "successes": stats.successes,
                "failures": stats.failures,
                "failovers": stats.failovers,
                "channelModels": stats.channel_models,
            })
        }
        "live-status" => json!({
            "activeThreads": state.proxy_runtime.snapshot_threads(),
            "memory": process_memory(),
        }),
        "logs" => {
            let stats = state.stats.snapshot().await;
            json!({
                "logs": stats.logs,
            })
        }
        _ => json!({}),
    };
    Json(value).into_response()
}

pub async fn health(State(state): State<AppState>) -> Response {
    let cfg = state.config.read().await.clone();
    let models = state.model_source.runtime_models(&cfg).await;
    Json(json!({
        "ok": true,
        "startedAt": state.stats.snapshot().await.started_at,
        "configPath": state.config_path.to_string_lossy(),
        "statsPath": state.stats_path.to_string_lossy(),
        "models": models.into_iter().map(|m| m.public_name).collect::<Vec<_>>(),
        "modelSourceError": state.model_source.error().await
    }))
    .into_response()
}

pub async fn providers_health(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let cfg = state.config.read().await.clone();
    if !state.auth.is_admin(&headers, &cfg) {
        return send_error(StatusCode::UNAUTHORIZED, "Invalid admin token", None);
    }
    let providers = body
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| configured_providers(&cfg));
    let refresh = body
        .get("refresh")
        .or_else(|| body.get("force"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let results = if refresh {
        state.provider_health.refresh_for(providers).await
    } else {
        state.provider_health.cached_for(providers).await
    };
    Json(json!({ "ok": true, "providers": results })).into_response()
}

pub async fn model_source_preview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let cfg = state.config.read().await.clone();
    if !state.auth.is_admin(&headers, &cfg) {
        return send_error(StatusCode::UNAUTHORIZED, "Invalid admin token", None);
    }
    let mut source_value = serde_json::to_value(cfg.model_source).unwrap_or_else(|_| json!({}));
    merge_json(&mut source_value, body);
    source_value["enabled"] = json!(true);
    let source =
        match serde_json::from_value(source_value).map(crate::config::normalize_model_source) {
            Ok(source) => source,
            Err(err) => return send_error(StatusCode::BAD_REQUEST, &err.to_string(), None),
        };
    match fetch_model_source(&state.client, &source).await {
        Ok(models) => {
            let filtered = filter_source_models(models, &source);
            Json(json!({
                "ok": true,
                "count": filtered.len(),
                "models": filtered.into_iter().take(200).map(|m| m.id).collect::<Vec<_>>()
            }))
            .into_response()
        }
        Err(err) => send_error(StatusCode::BAD_REQUEST, &err.to_string(), None),
    }
}

pub async fn model_source_refresh(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let cfg = state.config.read().await.clone();
    if !state.auth.is_admin(&headers, &cfg) {
        return send_error(StatusCode::UNAUTHORIZED, "Invalid admin token", None);
    }
    match state.model_source.source_runtime_models(&cfg, true).await {
        Ok(models) => {
            let mut runtime_models = cfg.models.clone();
            runtime_models.extend(models.clone());
            cleanup_runtime_state(&state, &runtime_models).await;
            Json(json!({
                "ok": true,
                "count": models.len(),
                "models": models.into_iter().take(200).map(|m| m.public_name).collect::<Vec<_>>()
            }))
            .into_response()
        }
        Err(err) => send_error(StatusCode::BAD_REQUEST, &err.to_string(), None),
    }
}

pub async fn model_tests_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let cfg = state.config.read().await.clone();
    if !state.auth.is_admin(&headers, &cfg) {
        return send_error(StatusCode::UNAUTHORIZED, "Invalid admin token", None);
    }
    let targets = body
        .get("targets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .take(50)
        .filter(|target| {
            target
                .get("baseUrl")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
                && target
                    .get("modelName")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
        })
        .collect::<Vec<_>>();
    if targets.is_empty() {
        return send_error(
            StatusCode::BAD_REQUEST,
            "No testable models were provided",
            None,
        );
    }
    let capabilities = normalize_capabilities(body.get("capabilities"));
    let mut results = Vec::new();
    for target in targets {
        results.push(test_model(&state.client, &target, &capabilities).await);
    }
    Json(json!({ "ok": true, "results": results })).into_response()
}

pub async fn static_ui() -> Response {
    embedded_response("index.html")
}

pub async fn app_css() -> Response {
    embedded_response("app.css")
}

pub async fn app_js() -> Response {
    embedded_response("app.js")
}

pub async fn app_core_js() -> Response {
    embedded_response("app-core.js")
}

pub async fn static_chunk(Path(path): Path<String>) -> Response {
    embedded_response(&format!("chunks/{}", sanitize_asset_path(&path)))
}

pub async fn static_asset(Path(path): Path<String>) -> Response {
    embedded_response(&sanitize_asset_path(&path))
}

fn embedded_response(path: &str) -> Response {
    let Some((body, content_type)) = embedded_asset(path) else {
        return send_error(StatusCode::NOT_FOUND, "Not Found", None);
    };
    named_asset(path, body, content_type)
}

fn named_asset(name: &str, body: &'static [u8], content_type: &'static str) -> Response {
    let mut response = Response::new(Body::from(Bytes::from_static(body)));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("inline; filename=\"{}\"", name))
            .unwrap_or_else(|_| HeaderValue::from_static("inline")),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

fn sanitize_asset_path(path: &str) -> String {
    path.split('/')
        .filter(|segment| {
            !segment.is_empty() && *segment != "." && *segment != ".." && !segment.contains('\\')
        })
        .collect::<Vec<_>>()
        .join("/")
}

async fn test_model(client: &reqwest::Client, target: &Value, capabilities: &[String]) -> Value {
    let started = crate::stats::now_ms();
    let mut results = Vec::new();
    for capability in capabilities {
        results.push(run_capability(client, target, capability).await);
    }
    let base_url = target.get("baseUrl").and_then(Value::as_str).unwrap_or("");
    let model_name = target
        .get("modelName")
        .and_then(Value::as_str)
        .unwrap_or("");
    json!({
        "id": target.get("id").and_then(Value::as_str).unwrap_or(""),
        "providerId": target.get("providerId").and_then(Value::as_str).unwrap_or(""),
        "providerName": target.get("providerName").or_else(|| target.get("name")).and_then(Value::as_str).unwrap_or(base_url),
        "baseUrl": base_url,
        "modelName": model_name,
        "startedAt": started,
        "latencyMs": crate::stats::now_ms().saturating_sub(started),
        "results": results
    })
}

async fn run_capability(client: &reqwest::Client, target: &Value, capability: &str) -> Value {
    let body = match capability {
        "tool" => json!({
            "messages": [{"role": "user", "content": "Return the current city by calling the tool."}],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "get_city",
                    "description": "Get city",
                    "parameters": {"type": "object", "properties": {}, "required": []}
                }
            }],
            "tool_choice": "auto",
            "stream": false
        }),
        "vision" => json!({
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "What color is this image?"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="}}
            ]}],
            "stream": false
        }),
        _ => json!({
            "messages": [{"role": "user", "content": "Say OK in one short sentence."}],
            "stream": false
        }),
    };
    let started = crate::stats::now_ms();
    let base_url = target
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_end_matches('/');
    let model_name = target
        .get("modelName")
        .and_then(Value::as_str)
        .unwrap_or("");
    let api_key = target.get("apiKey").and_then(Value::as_str).unwrap_or("");
    let mut payload = body;
    payload["model"] = json!(model_name);
    let res = client
        .post(format!("{}/chat/completions", base_url))
        .timeout(std::time::Duration::from_millis(45_000))
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await;
    match res {
        Ok(res) => {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            if status.is_success() {
                json!({
                    "capability": capability,
                    "status": "passed",
                    "latencyMs": crate::stats::now_ms().saturating_sub(started),
                    "detail": "Request completed",
                    "evidence": crate::proxy::trim_error(&text)
                })
            } else {
                json!({
                    "capability": capability,
                    "status": "failed",
                    "latencyMs": crate::stats::now_ms().saturating_sub(started),
                    "detail": format!("HTTP {}", status.as_u16()),
                    "evidence": crate::proxy::trim_error(&text)
                })
            }
        }
        Err(err) => json!({
            "capability": capability,
            "status": "failed",
            "detail": if err.is_timeout() { "Request timed out".to_string() } else { err.to_string() },
            "evidence": ""
        }),
    }
}

fn normalize_capabilities(value: Option<&Value>) -> Vec<String> {
    let allowed = ["text", "vision", "tool"];
    let mut out = value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|item| allowed.contains(item))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    out.sort();
    out.dedup();
    if out.is_empty() {
        vec!["text".to_string(), "vision".to_string(), "tool".to_string()]
    } else {
        out
    }
}

fn merge_json(target: &mut Value, patch: Value) {
    if let (Some(target), Some(patch)) = (target.as_object_mut(), patch.as_object()) {
        for (key, value) in patch {
            target.insert(key.clone(), value.clone());
        }
    }
}

async fn cleanup_runtime_state(state: &AppState, models: &[ModelConfig]) {
    state
        .proxy_runtime
        .retain_round_robin_models(models.iter().map(|model| model.public_name.as_str()));
    state.circuit_breakers.retain_targets(models);
    state.stats.retain_runtime_models(models).await;
}

fn process_memory() -> Value {
    #[cfg(windows)]
    {
        windows_process_memory()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        proc_status_memory()
    }
    #[cfg(all(not(windows), any(not(unix), target_os = "macos")))]
    {
        json!({
            "pid": std::process::id(),
            "workingSetBytes": 0u64,
            "peakWorkingSetBytes": 0u64,
            "privateBytes": 0u64,
            "virtualBytes": 0u64,
            "dataBytes": 0u64
        })
    }
}

#[cfg(windows)]
fn windows_process_memory() -> Value {
    use std::ffi::c_void;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct ProcessMemoryCountersEx {
        cb: u32,
        PageFaultCount: u32,
        PeakWorkingSetSize: usize,
        WorkingSetSize: usize,
        QuotaPeakPagedPoolUsage: usize,
        QuotaPagedPoolUsage: usize,
        QuotaPeakNonPagedPoolUsage: usize,
        QuotaNonPagedPoolUsage: usize,
        PagefileUsage: usize,
        PeakPagefileUsage: usize,
        PrivateUsage: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
    }

    #[link(name = "psapi")]
    extern "system" {
        fn GetProcessMemoryInfo(
            process: *mut c_void,
            counters: *mut ProcessMemoryCountersEx,
            cb: u32,
        ) -> i32;
    }

    let mut counters = ProcessMemoryCountersEx {
        cb: std::mem::size_of::<ProcessMemoryCountersEx>() as u32,
        PageFaultCount: 0,
        PeakWorkingSetSize: 0,
        WorkingSetSize: 0,
        QuotaPeakPagedPoolUsage: 0,
        QuotaPagedPoolUsage: 0,
        QuotaPeakNonPagedPoolUsage: 0,
        QuotaNonPagedPoolUsage: 0,
        PagefileUsage: 0,
        PeakPagefileUsage: 0,
        PrivateUsage: 0,
    };
    let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) } != 0;
    json!({
        "pid": std::process::id(),
        "workingSetBytes": if ok { counters.WorkingSetSize as u64 } else { 0 },
        "peakWorkingSetBytes": if ok { counters.PeakWorkingSetSize as u64 } else { 0 },
        "privateBytes": if ok { counters.PrivateUsage as u64 } else { 0 },
        "virtualBytes": if ok { counters.PagefileUsage as u64 } else { 0 },
        "dataBytes": 0u64
    })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn proc_status_memory() -> Value {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let kb = |name: &str| -> u64 {
        status
            .lines()
            .find_map(|line| {
                let value = line.strip_prefix(name)?.trim();
                value
                    .split_whitespace()
                    .next()
                    .and_then(|item| item.parse::<u64>().ok())
            })
            .unwrap_or(0)
            * 1024
    };
    json!({
        "pid": std::process::id(),
        "workingSetBytes": kb("VmRSS:"),
        "peakWorkingSetBytes": kb("VmHWM:"),
        "privateBytes": kb("RssAnon:"),
        "virtualBytes": kb("VmSize:"),
        "dataBytes": kb("VmData:")
    })
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
