use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path};
use tokio::fs;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub admin_token: String,
    pub proxy_keys: Vec<ProxyKey>,
    pub failover_status_codes: Vec<u16>,
    pub request_timeout_ms: u64,
    pub circuit_breaker: CircuitBreakerConfig,
    pub model_source: ModelSourceConfig,
    pub providers: Vec<ProviderConfig>,
    pub models: Vec<ModelConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProxyKey {
    pub name: String,
    pub key: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CircuitBreakerConfig {
    pub failure_threshold: u32,
    pub cooldown_minutes: u64,
    pub immediate_cooldown_status_codes: Vec<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelSourceConfig {
    pub enabled: bool,
    pub url: String,
    pub api_key: String,
    pub refresh_seconds: u64,
    pub include: String,
    pub exclude: String,
    pub public_prefix: String,
    pub public_suffix: String,
    pub targets: Vec<TargetConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub models: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelConfig {
    pub public_name: String,
    pub enabled: bool,
    pub strategy: FailoverStrategy,
    pub circuit_breaker: CircuitBreakerConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_model_name: Option<String>,
    pub targets: Vec<TargetConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TargetConfig {
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub model_name: String,
    pub model_name_template: String,
    pub enabled: bool,
    pub priority: u32,
    pub weight: u32,
    pub max_retries: u32,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum FailoverStrategy {
    Priority,
    RoundRobin,
    Weighted,
    LatencyBased,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            admin_token: "admin".to_string(),
            proxy_keys: vec![ProxyKey {
                name: "test-key".to_string(),
                key: "sk-local-test".to_string(),
                enabled: true,
            }],
            failover_status_codes: vec![401, 403, 408, 409, 429, 500, 502, 503, 504],
            request_timeout_ms: 120_000,
            circuit_breaker: CircuitBreakerConfig::default(),
            model_source: ModelSourceConfig::default(),
            providers: Vec::new(),
            models: vec![ModelConfig {
                public_name: "gpt-failover".to_string(),
                enabled: true,
                strategy: FailoverStrategy::Priority,
                circuit_breaker: CircuitBreakerConfig::default(),
                source_model_name: None,
                targets: normalize_targets(vec![
                    TargetConfig {
                        name: "primary-openai".to_string(),
                        base_url: "https://api.openai.com/v1".to_string(),
                        api_key: "sk-replace-me".to_string(),
                        model_name: "gpt-4.1-mini".to_string(),
                        enabled: true,
                        ..TargetConfig::default()
                    },
                    TargetConfig {
                        name: "backup-openai".to_string(),
                        base_url: "https://api.openai.com/v1".to_string(),
                        api_key: "sk-replace-me-too".to_string(),
                        model_name: "gpt-4o-mini".to_string(),
                        enabled: false,
                        ..TargetConfig::default()
                    },
                ]),
            }],
        }
    }
}

impl Default for ProxyKey {
    fn default() -> Self {
        Self {
            name: String::new(),
            key: String::new(),
            enabled: true,
        }
    }
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            failure_threshold: 3,
            cooldown_minutes: 10,
            immediate_cooldown_status_codes: vec![429],
        }
    }
}

impl Default for ModelSourceConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            url: String::new(),
            api_key: String::new(),
            refresh_seconds: 300,
            include: String::new(),
            exclude: String::new(),
            public_prefix: String::new(),
            public_suffix: String::new(),
            targets: normalize_targets(vec![
                TargetConfig {
                    name: "primary-openai".to_string(),
                    base_url: "https://api.openai.com/v1".to_string(),
                    api_key: "sk-replace-me".to_string(),
                    model_name_template: "{model}".to_string(),
                    enabled: true,
                    ..TargetConfig::default()
                },
                TargetConfig {
                    name: "backup-openai".to_string(),
                    base_url: "https://api.openai.com/v1".to_string(),
                    api_key: "sk-replace-me-too".to_string(),
                    model_name_template: "{model}".to_string(),
                    enabled: false,
                    ..TargetConfig::default()
                },
            ]),
        }
    }
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            public_name: String::new(),
            enabled: true,
            strategy: FailoverStrategy::Priority,
            circuit_breaker: CircuitBreakerConfig::default(),
            source_model_name: None,
            targets: Vec::new(),
        }
    }
}

impl Default for TargetConfig {
    fn default() -> Self {
        Self {
            name: String::new(),
            base_url: String::new(),
            api_key: String::new(),
            model_name: String::new(),
            model_name_template: String::new(),
            enabled: true,
            priority: 1,
            weight: 1,
            max_retries: 0,
            timeout_ms: 120_000,
        }
    }
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            base_url: String::new(),
            api_key: String::new(),
            models: Vec::new(),
            timeout_ms: None,
        }
    }
}

impl Default for FailoverStrategy {
    fn default() -> Self {
        FailoverStrategy::Priority
    }
}

pub fn normalize_config(mut cfg: Config) -> Config {
    let defaults = Config::default();
    if cfg.admin_token.is_empty() {
        cfg.admin_token = defaults.admin_token;
    }
    if cfg.failover_status_codes.is_empty() {
        cfg.failover_status_codes = defaults.failover_status_codes;
    }
    if cfg.request_timeout_ms == 0 {
        cfg.request_timeout_ms = defaults.request_timeout_ms;
    }
    cfg.circuit_breaker = normalize_circuit(cfg.circuit_breaker);
    cfg.model_source = normalize_model_source(cfg.model_source);
    cfg.providers = normalize_providers(cfg.providers);
    cfg.models = cfg.models.into_iter().map(normalize_model).collect();
    cfg
}

pub fn normalize_model(mut model: ModelConfig) -> ModelConfig {
    model.circuit_breaker = normalize_circuit(model.circuit_breaker);
    model.targets = normalize_targets(model.targets);
    model
}

pub fn normalize_targets(targets: Vec<TargetConfig>) -> Vec<TargetConfig> {
    let mut out: Vec<TargetConfig> = targets
        .into_iter()
        .enumerate()
        .map(|(idx, mut target)| {
            if target.priority == 0 {
                target.priority = (idx + 1) as u32;
            }
            if target.weight == 0 {
                target.weight = 1;
            }
            if target.timeout_ms == 0 {
                target.timeout_ms = Config::default().request_timeout_ms;
            }
            target
        })
        .collect();
    out.sort_by_key(|target| target.priority);
    for (idx, target) in out.iter_mut().enumerate() {
        target.priority = (idx + 1) as u32;
    }
    out
}

pub fn normalize_circuit(mut breaker: CircuitBreakerConfig) -> CircuitBreakerConfig {
    if breaker.failure_threshold == 0 {
        breaker.failure_threshold = 3;
    }
    if breaker.cooldown_minutes == 0 {
        breaker.cooldown_minutes = 10;
    }
    if breaker.immediate_cooldown_status_codes.is_empty() {
        breaker.immediate_cooldown_status_codes = vec![429];
    }
    breaker
}

pub fn normalize_model_source(mut source: ModelSourceConfig) -> ModelSourceConfig {
    if source.refresh_seconds == 0 {
        source.refresh_seconds = 300;
    }
    source.targets = normalize_targets(source.targets);
    source
}

pub fn normalize_providers(providers: Vec<ProviderConfig>) -> Vec<ProviderConfig> {
    providers
        .into_iter()
        .map(|mut provider| {
            provider.base_url = trim_slashes(&provider.base_url);
            provider.models = unique_strings(provider.models);
            provider
        })
        .filter(|provider| !provider.base_url.is_empty())
        .collect()
}

pub fn unique_strings(items: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    items
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty() && seen.insert(item.clone()))
        .collect()
}

pub async fn ensure_config(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    if fs::metadata(path).await.is_err() {
        let text = serde_json::to_string_pretty(&Config::default())?;
        fs::write(path, text).await?;
    }
    Ok(())
}

pub async fn load_config(path: &Path) -> Result<Config> {
    ensure_config(path).await?;
    let text = fs::read_to_string(path)
        .await
        .with_context(|| format!("cannot read config {}", path.display()))?;
    let cfg: Config = serde_json::from_str(&text)
        .with_context(|| format!("cannot parse config {}", path.display()))?;
    Ok(normalize_config(cfg))
}

pub async fn save_config(path: &Path, cfg: &Config) -> Result<Config> {
    let normalized = normalize_config(cfg.clone());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let tmp = path.with_file_name(format!(
        "{}.{}.tmp",
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("config.json"),
        Uuid::new_v4()
    ));
    let text = serde_json::to_string_pretty(&normalized)?;
    fs::write(&tmp, text).await?;
    fs::rename(&tmp, path).await?;
    Ok(normalized)
}

pub fn model_circuit(model: &ModelConfig, cfg: &Config) -> CircuitBreakerConfig {
    let mut breaker = cfg.circuit_breaker.clone();
    let model_breaker = &model.circuit_breaker;
    breaker.failure_threshold = model_breaker.failure_threshold;
    breaker.cooldown_minutes = model_breaker.cooldown_minutes;
    breaker.immediate_cooldown_status_codes = model_breaker.immediate_cooldown_status_codes.clone();
    normalize_circuit(breaker)
}

pub fn trim_slashes(input: &str) -> String {
    input.trim_end_matches('/').to_string()
}

pub fn endpoint_suffix(path: &str) -> String {
    let cleaned = path.trim_start_matches('/');
    let suffix = cleaned.strip_prefix("v1/").unwrap_or(cleaned);
    if suffix == "response" {
        "responses".to_string()
    } else {
        suffix.to_string()
    }
}

pub fn upstream_url(target: &TargetConfig, path: &str) -> String {
    format!(
        "{}/{}",
        trim_slashes(&target.base_url),
        endpoint_suffix(path)
    )
}

pub fn target_key(model: &ModelConfig, target: &TargetConfig) -> String {
    format!(
        "{}/{}/{}/{}",
        model.public_name, target.name, target.model_name, target.base_url
    )
}

pub fn target_label(target: &TargetConfig) -> String {
    if !target.model_name.is_empty() {
        target.model_name.clone()
    } else if !target.name.is_empty() {
        target.name.clone()
    } else {
        target.base_url.clone()
    }
}

pub fn channel_label(target: &TargetConfig) -> String {
    if !target.name.is_empty() {
        target.name.clone()
    } else {
        provider_name_from_url(&target.base_url).unwrap_or_else(|| "unknown".to_string())
    }
}

pub fn channel_model_label(target: &TargetConfig) -> String {
    if !target.model_name.is_empty() {
        target.model_name.clone()
    } else if !target.model_name_template.is_empty() {
        target.model_name_template.clone()
    } else if !target.name.is_empty() {
        target.name.clone()
    } else if !target.base_url.is_empty() {
        target.base_url.clone()
    } else {
        "unknown".to_string()
    }
}

pub fn provider_name_from_url(url: &str) -> Option<String> {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_string()))
}

#[cfg(test)]
mod tests {
    use super::endpoint_suffix;

    #[test]
    fn response_alias_uses_openai_responses_endpoint() {
        assert_eq!(endpoint_suffix("/v1/response"), "responses");
        assert_eq!(endpoint_suffix("/response"), "responses");
        assert_eq!(endpoint_suffix("/v1/responses"), "responses");
        assert_eq!(endpoint_suffix("/responses"), "responses");
    }
}
