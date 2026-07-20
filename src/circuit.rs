use crate::{
    config::{model_circuit, target_key, Config, ModelConfig, TargetConfig},
    stats::{now_ms, FailureInfo, StatsStore},
};
use dashmap::DashMap;
use std::{collections::HashSet, sync::Arc};

#[derive(Debug, Clone, Default)]
pub struct BreakerState {
    pub failures: u32,
    pub disabled_until: u64,
}

#[derive(Clone, Default)]
pub struct CircuitBreakers {
    inner: Arc<DashMap<String, BreakerState>>,
}

impl CircuitBreakers {
    pub fn is_open(&self, model: &ModelConfig, target: &TargetConfig) -> bool {
        let key = target_key(model, target);
        let Some(item) = self.inner.get(&key) else {
            return false;
        };
        let disabled_until = item.disabled_until;
        if disabled_until == 0 {
            return false;
        }
        if now_ms() >= disabled_until {
            drop(item);
            self.inner.remove(&key);
            return false;
        }
        true
    }

    pub async fn is_open_and_cleanup(
        &self,
        model: &ModelConfig,
        target: &TargetConfig,
        stats: &StatsStore,
    ) -> bool {
        let key = target_key(model, target);
        let Some(item) = self.inner.get(&key) else {
            return false;
        };
        let disabled_until = item.disabled_until;
        if disabled_until == 0 {
            return false;
        }
        if now_ms() >= disabled_until {
            drop(item);
            self.inner.remove(&key);
            stats.clear_target_breaker_stats(model, target).await;
            return false;
        }
        true
    }

    pub async fn record_success(
        &self,
        model: &ModelConfig,
        target: &TargetConfig,
        cfg: &Config,
        stats: &StatsStore,
        latency_ms: u64,
    ) {
        let key = target_key(model, target);
        self.inner.remove(&key);
        stats
            .record_target(
                model,
                target,
                true,
                cfg,
                FailureInfo::default(),
                latency_ms,
                0,
                0,
            )
            .await;
    }

    pub async fn record_failure(
        &self,
        model: &ModelConfig,
        target: &TargetConfig,
        cfg: &Config,
        stats: &StatsStore,
        failure: FailureInfo,
        latency_ms: u64,
    ) {
        let key = target_key(model, target);
        let breaker_cfg = model_circuit(model, cfg);
        let mut state = self.inner.entry(key).or_default();
        state.failures += 1;
        if state.failures >= breaker_cfg.failure_threshold
            || breaker_cfg
                .immediate_cooldown_status_codes
                .contains(&failure.status)
        {
            state.disabled_until = now_ms() + breaker_cfg.cooldown_minutes * 60 * 1000;
        }
        let disabled_until = state.disabled_until;
        let failures = state.failures;
        drop(state);
        stats
            .record_target(
                model,
                target,
                false,
                cfg,
                failure,
                latency_ms,
                disabled_until,
                failures,
            )
            .await;
    }

    pub async fn reset_model(&self, model: &ModelConfig, stats: &StatsStore) {
        for target in &model.targets {
            self.inner.remove(&target_key(model, target));
            stats.clear_target_breaker_stats(model, target).await;
        }
    }

    pub fn retain_targets(&self, models: &[ModelConfig]) {
        let valid = models
            .iter()
            .flat_map(|model| {
                model
                    .targets
                    .iter()
                    .map(|target| target_key(model, target))
                    .collect::<Vec<_>>()
            })
            .collect::<HashSet<_>>();
        let stale = self
            .inner
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
            self.inner.remove(&key);
        }
    }
}
