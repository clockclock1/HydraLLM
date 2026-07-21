use crate::config::{
    channel_label, channel_model_label, model_circuit, target_key, Config, ModelConfig,
    TargetConfig,
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    sync::Arc,
};
use tokio::{fs, sync::RwLock};
use uuid::Uuid;

const REQUEST_LOG_LIMIT: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Stats {
    pub started_at: String,
    pub requests: u64,
    pub successes: u64,
    pub failures: u64,
    pub failovers: u64,
    pub targets: BTreeMap<String, TargetStats>,
    pub chains: BTreeMap<String, ChainStats>,
    pub channel_models: BTreeMap<String, ChannelModelStats>,
    pub logs: Vec<LogEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct TargetStats {
    pub model: String,
    pub target: String,
    pub upstream_model: String,
    pub base_url: String,
    pub ok: u64,
    pub error: u64,
    pub consecutive_failures: u32,
    pub disabled_until: u64,
    pub last_status: u16,
    pub last_error: String,
    pub last_latency_ms: u64,
    pub avg_latency_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ChainStats {
    pub requests: u64,
    pub successes: u64,
    pub failures: u64,
    pub failovers: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ChannelModelStats {
    pub name: String,
    pub base_url: String,
    pub requests: u64,
    pub successes: u64,
    pub failures: u64,
    pub models: BTreeMap<String, ChannelModelItemStats>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ChannelModelItemStats {
    pub name: String,
    pub requests: u64,
    pub successes: u64,
    pub failures: u64,
    pub last_status: u16,
    pub last_error: String,
    pub last_latency_ms: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LogEntry {
    pub id: String,
    pub timestamp: u64,
    pub chain_name: String,
    pub original_model: String,
    pub failed_models: Vec<String>,
    pub final_model: String,
    pub status: String,
    pub latency: u64,
    pub error: String,
}

#[derive(Clone)]
pub struct StatsStore {
    inner: Arc<RwLock<Stats>>,
    path: Arc<PathBuf>,
}

#[derive(Debug, Clone, Default)]
pub struct FailureInfo {
    pub status: u16,
    pub message: String,
    pub body: String,
}

impl Default for Stats {
    fn default() -> Self {
        Self {
            started_at: chrono_like_now(),
            requests: 0,
            successes: 0,
            failures: 0,
            failovers: 0,
            targets: BTreeMap::new(),
            chains: BTreeMap::new(),
            channel_models: BTreeMap::new(),
            logs: Vec::new(),
        }
    }
}

impl Default for LogEntry {
    fn default() -> Self {
        Self {
            id: String::new(),
            timestamp: 0,
            chain_name: String::new(),
            original_model: String::new(),
            failed_models: Vec::new(),
            final_model: String::new(),
            status: String::new(),
            latency: 0,
            error: String::new(),
        }
    }
}

impl StatsStore {
    pub async fn load(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let stats = match fs::read_to_string(&path).await {
            Ok(text) => serde_json::from_str::<Stats>(&text)
                .unwrap_or_default()
                .normalize(),
            Err(_) => Stats::default(),
        };
        let store = Self {
            inner: Arc::new(RwLock::new(stats)),
            path: Arc::new(path),
        };
        store.save_now().await?;
        Ok(store)
    }

    pub async fn snapshot(&self) -> Stats {
        self.inner.read().await.clone().normalize()
    }

    pub async fn mutate<F>(&self, f: F)
    where
        F: FnOnce(&mut Stats),
    {
        let mut stats = self.inner.write().await;
        f(&mut stats);
        trim_logs(&mut stats.logs);
    }

    pub async fn save_now(&self) -> Result<()> {
        let snapshot = self.snapshot().await;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let tmp = self.path.with_file_name(format!(
            "{}.{}.tmp",
            self.path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("stats.json"),
            Uuid::new_v4()
        ));
        fs::write(&tmp, serde_json::to_vec_pretty(&snapshot)?).await?;
        fs::rename(&tmp, &*self.path).await?;
        Ok(())
    }

    pub fn spawn_periodic_save(&self) {
        let store = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                interval.tick().await;
                if let Err(err) = store.save_now().await {
                    tracing::warn!(error = %err, "cannot save stats");
                }
            }
        });
    }

    pub async fn record_target(
        &self,
        model: &ModelConfig,
        target: &TargetConfig,
        ok: bool,
        cfg: &Config,
        failure: FailureInfo,
        latency_ms: u64,
        disabled_until: u64,
        consecutive_failures: u32,
    ) {
        let key = target_key(model, target);
        let breaker = model_circuit(model, cfg);
        self.mutate(|stats| {
            let item = stats
                .targets
                .entry(key.clone())
                .or_insert_with(|| TargetStats {
                    model: model.public_name.clone(),
                    target: if !target.model_name.is_empty() {
                        target.model_name.clone()
                    } else if !target.name.is_empty() {
                        target.name.clone()
                    } else {
                        target.base_url.clone()
                    },
                    upstream_model: target.model_name.clone(),
                    base_url: target.base_url.clone(),
                    ..TargetStats::default()
                });
            let measured = latency_ms;
            if measured > 0 {
                item.last_latency_ms = measured;
                item.avg_latency_ms = if item.avg_latency_ms > 0 {
                    ((item.avg_latency_ms as f64 * 0.8) + (measured as f64 * 0.2)).round() as u64
                } else {
                    measured
                };
            }
            if ok {
                item.ok += 1;
                item.consecutive_failures = 0;
                item.disabled_until = 0;
                item.last_status = 0;
                item.last_error.clear();
            } else {
                item.error += 1;
                item.consecutive_failures = consecutive_failures
                    .max(1)
                    .max(if breaker.failure_threshold == 0 { 1 } else { 0 });
                item.disabled_until = disabled_until;
                item.last_status = failure.status;
                item.last_error = if failure.message.is_empty() {
                    trim_persisted_string(&failure.body)
                } else {
                    trim_persisted_string(&failure.message)
                };
            }
            record_channel(stats, target, ok, &failure, measured);
        })
        .await;
    }

    pub async fn clear_target_breaker_stats(&self, model: &ModelConfig, target: &TargetConfig) {
        let key = target_key(model, target);
        self.mutate(|stats| {
            if let Some(item) = stats.targets.get_mut(&key) {
                item.consecutive_failures = 0;
                item.disabled_until = 0;
            }
        })
        .await;
    }

    pub async fn chain_request(&self, public_name: &str) {
        let key = public_name.to_string();
        self.mutate(|stats| {
            stats.requests += 1;
            stats.chains.entry(key).or_default().requests += 1;
        })
        .await;
    }

    pub async fn chain_success(&self, public_name: &str, failover: bool) {
        let key = public_name.to_string();
        self.mutate(|stats| {
            stats.successes += 1;
            let chain = stats.chains.entry(key).or_default();
            chain.successes += 1;
            if failover {
                stats.failovers += 1;
                chain.failovers += 1;
            }
        })
        .await;
    }

    pub async fn chain_failure(&self, public_name: &str) {
        let key = public_name.to_string();
        self.mutate(|stats| {
            stats.failures += 1;
            stats.chains.entry(key).or_default().failures += 1;
        })
        .await;
    }

    pub async fn add_log(&self, mut entry: LogEntry) {
        if entry.id.is_empty() {
            entry.id = Uuid::new_v4().to_string();
        }
        if entry.timestamp == 0 {
            entry.timestamp = now_ms();
        }
        entry.error = trim_persisted_string(&entry.error);
        self.mutate(|stats| {
            push_request_log(&mut stats.logs, entry);
        })
        .await;
    }

    pub async fn avg_latency(&self, model: &ModelConfig, target: &TargetConfig) -> u64 {
        let key = target_key(model, target);
        self.inner
            .read()
            .await
            .targets
            .get(&key)
            .map(|item| item.avg_latency_ms)
            .unwrap_or(0)
    }

    pub async fn retain_runtime_models(&self, models: &[ModelConfig]) {
        let valid_chains = models
            .iter()
            .map(|model| model.public_name.clone())
            .collect::<HashSet<_>>();
        let valid_targets = models
            .iter()
            .flat_map(|model| {
                model
                    .targets
                    .iter()
                    .map(|target| target_key(model, target))
                    .collect::<Vec<_>>()
            })
            .collect::<HashSet<_>>();
        let mut valid_channel_models: BTreeMap<String, HashSet<String>> = BTreeMap::new();
        for model in models {
            for target in &model.targets {
                valid_channel_models
                    .entry(channel_label(target))
                    .or_default()
                    .insert(channel_model_label(target));
            }
        }
        self.mutate(|stats| {
            stats.chains.retain(|name, _| valid_chains.contains(name));
            stats.targets.retain(|key, _| valid_targets.contains(key));
            stats.channel_models.retain(|channel_name, channel| {
                let Some(valid_models) = valid_channel_models.get(channel_name) else {
                    return false;
                };
                channel
                    .models
                    .retain(|model_name, _| valid_models.contains(model_name));
                !channel.models.is_empty()
            });
        })
        .await;
    }
}

impl Stats {
    fn normalize(mut self) -> Self {
        self.requests = self.requests.max(0);
        self.successes = self.successes.max(0);
        self.failures = self.failures.max(0);
        self.failovers = self.failovers.max(0);
        trim_logs(&mut self.logs);
        for target in self.targets.values_mut() {
            target.last_error = trim_persisted_string(&target.last_error);
        }
        for channel in self.channel_models.values_mut() {
            for model in channel.models.values_mut() {
                model.last_error = trim_persisted_string(&model.last_error);
            }
        }
        self
    }
}

fn record_channel(
    stats: &mut Stats,
    target: &TargetConfig,
    ok: bool,
    failure: &FailureInfo,
    latency_ms: u64,
) {
    let channel_name = channel_label(target);
    let model_name = channel_model_label(target);
    let channel = stats
        .channel_models
        .entry(channel_name.clone())
        .or_insert_with(|| ChannelModelStats {
            name: channel_name,
            base_url: target.base_url.clone(),
            ..ChannelModelStats::default()
        });
    if channel.base_url.is_empty() {
        channel.base_url = target.base_url.clone();
    }
    channel.requests += 1;
    if ok {
        channel.successes += 1;
    } else {
        channel.failures += 1;
    }

    let item = channel
        .models
        .entry(model_name.clone())
        .or_insert_with(|| ChannelModelItemStats {
            name: model_name,
            ..ChannelModelItemStats::default()
        });
    item.requests += 1;
    if ok {
        item.successes += 1;
        item.last_status = 0;
        item.last_error.clear();
    } else {
        item.failures += 1;
        item.last_status = failure.status;
        item.last_error = if failure.message.is_empty() {
            trim_persisted_string(&failure.body)
        } else {
            trim_persisted_string(&failure.message)
        };
    }
    item.last_latency_ms = latency_ms;
    item.updated_at = now_ms();
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn chrono_like_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn trim_logs(logs: &mut Vec<LogEntry>) {
    logs.truncate(REQUEST_LOG_LIMIT);
    if logs.capacity() > REQUEST_LOG_LIMIT + 100 {
        logs.shrink_to_fit();
    }
}

fn push_request_log(logs: &mut Vec<LogEntry>, entry: LogEntry) {
    if logs.len() >= REQUEST_LOG_LIMIT {
        logs.truncate(REQUEST_LOG_LIMIT - 1);
    }
    logs.insert(0, entry);
    if logs.capacity() > REQUEST_LOG_LIMIT + 100 {
        logs.shrink_to_fit();
    }
}

fn trim_persisted_string(value: &str) -> String {
    value.chars().take(1500).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log(id: usize) -> LogEntry {
        LogEntry {
            id: id.to_string(),
            timestamp: id as u64,
            ..LogEntry::default()
        }
    }

    #[test]
    fn push_request_log_replaces_oldest_when_full() {
        let mut logs = (0..REQUEST_LOG_LIMIT).map(log).collect::<Vec<_>>();

        push_request_log(&mut logs, log(REQUEST_LOG_LIMIT));

        assert_eq!(logs.len(), REQUEST_LOG_LIMIT);
        assert_eq!(logs.first().map(|entry| entry.id.as_str()), Some("500"));
        assert_eq!(logs.last().map(|entry| entry.id.as_str()), Some("498"));
        assert!(!logs.iter().any(|entry| entry.id == "499"));
    }

    #[test]
    fn trim_logs_keeps_only_limit() {
        let mut logs = (0..REQUEST_LOG_LIMIT + 10).map(log).collect::<Vec<_>>();

        trim_logs(&mut logs);

        assert_eq!(logs.len(), REQUEST_LOG_LIMIT);
        assert_eq!(logs.last().map(|entry| entry.id.as_str()), Some("499"));
    }
}
