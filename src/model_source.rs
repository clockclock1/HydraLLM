use crate::config::{normalize_model, Config, ModelConfig, ModelSourceConfig, TargetConfig};
use anyhow::{anyhow, Result};
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceModel {
    pub id: String,
}

#[derive(Debug, Clone, Default)]
pub struct ModelSourceCache {
    pub cache_key: String,
    pub fetched_at: u64,
    pub models: Vec<ModelConfig>,
    pub error: String,
}

#[derive(Clone)]
pub struct ModelSourceService {
    cache: Arc<RwLock<ModelSourceCache>>,
    client: Client,
}

impl ModelSourceService {
    pub fn new(client: Client) -> Self {
        Self {
            cache: Arc::new(RwLock::new(ModelSourceCache::default())),
            client,
        }
    }

    pub async fn error(&self) -> String {
        self.cache.read().await.error.clone()
    }

    pub async fn cached_models(&self) -> Vec<ModelConfig> {
        self.cache.read().await.models.clone()
    }

    pub async fn runtime_models(&self, cfg: &Config) -> Vec<ModelConfig> {
        let explicit = cfg
            .models
            .iter()
            .filter(|model| model.enabled)
            .cloned()
            .collect::<Vec<_>>();
        let source = match self.source_runtime_models(cfg, false).await {
            Ok(models) => models,
            Err(err) => {
                self.cache.write().await.error = err.to_string();
                Vec::new()
            }
        };
        let mut seen = std::collections::HashSet::new();
        explicit
            .into_iter()
            .chain(source.into_iter())
            .filter(|model| seen.insert(model.public_name.clone()))
            .collect()
    }

    pub async fn find_model(&self, cfg: &Config, public_name: &str) -> Option<ModelConfig> {
        self.runtime_models(cfg)
            .await
            .into_iter()
            .find(|model| model.enabled && model.public_name == public_name)
    }

    pub async fn source_runtime_models(
        &self,
        cfg: &Config,
        force: bool,
    ) -> Result<Vec<ModelConfig>> {
        let source = &cfg.model_source;
        if !source.enabled || source.url.is_empty() {
            return Ok(Vec::new());
        }
        let cache_key = source_cache_key(source);
        let max_age_ms = source.refresh_seconds.max(1) * 1000;
        {
            let cache = self.cache.read().await;
            if !force
                && cache.cache_key == cache_key
                && crate::stats::now_ms().saturating_sub(cache.fetched_at) < max_age_ms
            {
                return Ok(cache.models.clone());
            }
        }
        let remote = fetch_model_source(&self.client, source).await?;
        let filtered = filter_source_models(remote, source);
        let generated = filtered
            .into_iter()
            .map(|item| {
                let public_name = format!(
                    "{}{}{}",
                    source.public_prefix, item.id, source.public_suffix
                );
                normalize_model(ModelConfig {
                    public_name,
                    enabled: true,
                    source_model_name: Some(item.id.clone()),
                    targets: source
                        .targets
                        .iter()
                        .cloned()
                        .map(|mut target| {
                            target.model_name = resolve_target_model_name(&target, &item.id);
                            target
                        })
                        .collect(),
                    ..ModelConfig::default()
                })
            })
            .collect::<Vec<_>>();
        let mut cache = self.cache.write().await;
        cache.cache_key = cache_key;
        cache.fetched_at = crate::stats::now_ms();
        cache.models = generated.clone();
        cache.error.clear();
        Ok(generated)
    }
}

pub async fn fetch_model_source(
    client: &Client,
    source: &ModelSourceConfig,
) -> Result<Vec<SourceModel>> {
    let mut request = client
        .get(&source.url)
        .timeout(Duration::from_millis(30_000))
        .header("accept", "application/json");
    if !source.api_key.is_empty() {
        request = request.bearer_auth(&source.api_key);
    }
    let res = request.send().await?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!(
            "Model source returned {}: {}",
            status.as_u16(),
            crate::proxy::trim_error(&text)
        ));
    }
    let payload: Value = serde_json::from_str(&text)?;
    Ok(extract_source_models(&payload))
}

pub async fn check_provider_health(client: &Client, provider: &Value) -> Value {
    let started = crate::stats::now_ms();
    let id = provider
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let name = provider
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let base_url = provider
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_end_matches('/')
        .to_string();
    let api_key = provider.get("apiKey").and_then(Value::as_str).unwrap_or("");
    let timeout_ms = provider
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(10_000);
    let mut result = serde_json::json!({
        "id": id,
        "name": name,
        "baseUrl": base_url,
        "status": "offline",
        "latency": 0u64,
        "models": [],
        "error": ""
    });
    if base_url.is_empty() {
        result["latency"] = serde_json::json!(crate::stats::now_ms().saturating_sub(started));
        result["error"] = serde_json::json!("missing baseUrl");
        return result;
    }
    let mut req = client
        .get(format!("{}/models", base_url))
        .timeout(Duration::from_millis(timeout_ms))
        .header("accept", "application/json");
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }
    match req.send().await {
        Ok(res) => {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            result["latency"] = serde_json::json!(crate::stats::now_ms().saturating_sub(started));
            if !status.is_success() {
                result["error"] = serde_json::json!(format!(
                    "HTTP {}: {}",
                    status.as_u16(),
                    crate::proxy::trim_error(&text)
                ));
                return result;
            }
            match serde_json::from_str::<Value>(&text) {
                Ok(payload) => {
                    let models = extract_source_models(&payload)
                        .into_iter()
                        .map(|item| item.id)
                        .collect::<Vec<_>>();
                    result["status"] = serde_json::json!("online");
                    result["models"] = serde_json::json!(models);
                }
                Err(err) => {
                    result["error"] = serde_json::json!(err.to_string());
                }
            }
        }
        Err(err) => {
            result["latency"] = serde_json::json!(crate::stats::now_ms().saturating_sub(started));
            result["error"] = serde_json::json!(if err.is_timeout() {
                "timeout".to_string()
            } else {
                err.to_string()
            });
        }
    }
    result
}

pub fn configured_providers(cfg: &Config) -> Vec<Value> {
    let mut targets: Vec<TargetConfig> = cfg
        .models
        .iter()
        .flat_map(|model| model.targets.clone())
        .collect();
    targets.extend(cfg.model_source.targets.clone());
    let mut seen = std::collections::HashSet::new();
    targets
        .into_iter()
        .filter(|target| !target.base_url.is_empty())
        .filter_map(|target| {
            let key = format!("{}|{}|{}", target.name, target.base_url, target.api_key);
            if !seen.insert(key) {
                return None;
            }
            Some(serde_json::json!({
                "id": format!("{}|{}|{}", target.name, target.base_url, target.api_key),
                "name": if target.name.is_empty() { target.base_url.clone() } else { target.name.clone() },
                "baseUrl": target.base_url,
                "apiKey": target.api_key,
            }))
        })
        .collect()
}

pub fn extract_source_models(payload: &Value) -> Vec<SourceModel> {
    let list = if payload.is_array() {
        payload.as_array()
    } else if payload.get("data").is_some_and(Value::is_array) {
        payload.get("data").and_then(Value::as_array)
    } else if payload.get("models").is_some_and(Value::is_array) {
        payload.get("models").and_then(Value::as_array)
    } else {
        None
    };
    list.unwrap_or(&Vec::new())
        .iter()
        .filter_map(|item| {
            if let Some(id) = item.as_str() {
                return Some(SourceModel { id: id.to_string() });
            }
            let id = item
                .get("id")
                .or_else(|| item.get("name"))
                .or_else(|| item.get("model"))
                .or_else(|| item.get("publicName"))
                .and_then(Value::as_str)?;
            Some(SourceModel { id: id.to_string() })
        })
        .collect()
}

pub fn filter_source_models(
    models: Vec<SourceModel>,
    source: &ModelSourceConfig,
) -> Vec<SourceModel> {
    let include = compile_pattern(&source.include);
    let exclude = compile_pattern(&source.exclude);
    models
        .into_iter()
        .filter(|item| {
            if include.as_ref().is_some_and(|re| !re.is_match(&item.id)) {
                return false;
            }
            if exclude.as_ref().is_some_and(|re| re.is_match(&item.id)) {
                return false;
            }
            true
        })
        .collect()
}

fn compile_pattern(pattern: &str) -> Option<Regex> {
    if pattern.is_empty() {
        return None;
    }
    Regex::new(pattern).ok()
}

pub fn resolve_target_model_name(target: &TargetConfig, source_model_name: &str) -> String {
    let template = if !target.model_name_template.is_empty() {
        target.model_name_template.as_str()
    } else if !target.model_name.is_empty() {
        target.model_name.as_str()
    } else {
        "{model}"
    };
    template.replace("{model}", source_model_name)
}

pub fn source_cache_key(source: &ModelSourceConfig) -> String {
    [
        source.enabled.to_string(),
        source.url.clone(),
        if source.api_key.is_empty() {
            "no-key"
        } else {
            "with-key"
        }
        .to_string(),
        source.include.clone(),
        source.exclude.clone(),
        source.public_prefix.clone(),
        source.public_suffix.clone(),
    ]
    .join("|")
}
