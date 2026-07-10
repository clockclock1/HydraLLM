import React, { createContext, useContext, useCallback, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { Provider, FailoverChain, Page, LogEntry, ModelCapability, ModelTestResult, ModelTestTarget } from './types';

interface BackendTarget {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  modelName?: string;
  modelNameTemplate?: string;
  enabled?: boolean;
  timeoutMs?: number;
  priority?: number;
  weight?: number;
  maxRetries?: number;
}

interface BackendModel {
  publicName: string;
  enabled?: boolean;
  strategy?: FailoverChain['strategy'];
  concurrency?: number;
  releaseDelayMs?: number;
  targets?: BackendTarget[];
}

interface BackendProvider {
  id?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
}

interface BackendConfig {
  adminToken: string;
  proxyKeys: { name?: string; key: string; enabled?: boolean }[];
  failoverStatusCodes: number[];
  requestTimeoutMs: number;
  circuitBreaker?: {
    failureThreshold?: number;
    cooldownMinutes?: number;
    immediateCooldownStatusCodes?: number[];
  };
  modelSource?: unknown;
  providers?: BackendProvider[];
  models: BackendModel[];
}

interface BackendStats {
  requests: number;
  successes: number;
  failures: number;
  failovers?: number;
  chains?: Record<string, {
    requests: number;
    successes: number;
    failures: number;
    failovers: number;
  }>;
  logs?: Array<{
    id: string;
    timestamp: number;
    chainName: string;
    originalModel: string;
    failedModels: string[];
    finalModel: string;
    status: 'success' | 'failed';
    latency: number;
    error?: string;
  }>;
}

interface State {
  currentPage: Page;
  providers: Provider[];
  chains: FailoverChain[];
  logs: LogEntry[];
  sidebarCollapsed: boolean;
  adminToken: string;
  configLoaded: boolean;
  saveStatus: 'idle' | 'loading' | 'saving' | 'saved' | 'error';
  saveError: string;
  backendConfig: BackendConfig | null;
  backendStats: BackendStats | null;
  circuitFailureThreshold: number;
  circuitCooldownMinutes: number;
  targetTimeoutSeconds: number;
  targetMaxRetries: number;
}

type Action =
  | { type: 'SET_PAGE'; page: Page }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_ADMIN_TOKEN'; token: string }
  | { type: 'SET_CIRCUIT_SETTINGS'; failureThreshold: number; cooldownMinutes: number }
  | { type: 'SET_TARGET_SETTINGS'; timeoutSeconds: number; maxRetries: number }
  | { type: 'SET_SAVE_STATUS'; status: State['saveStatus']; error?: string }
  | { type: 'LOAD_BACKEND_STATE'; config: BackendConfig; stats?: BackendStats | null }
  | { type: 'LOAD_BACKEND_STATS'; stats: BackendStats }
  | { type: 'ADD_PROVIDER'; provider: Provider }
  | { type: 'UPDATE_PROVIDER'; provider: Provider }
  | { type: 'DELETE_PROVIDER'; id: string }
  | { type: 'SET_PROVIDER_MODELS'; id: string; models: string[] }
  | { type: 'SET_PROVIDER_STATUS'; id: string; status: Provider['status']; latency?: number }
  | { type: 'SET_PROVIDER_HEALTHS'; providers: Array<{ id?: string; name?: string; baseUrl: string; status: Provider['status']; latency?: number; models?: string[]; error?: string }> }
  | { type: 'ADD_CHAIN'; chain: FailoverChain }
  | { type: 'UPDATE_CHAIN'; chain: FailoverChain }
  | { type: 'DELETE_CHAIN'; id: string }
  | { type: 'ADD_LOG'; log: LogEntry };

const defaultConfig: BackendConfig = {
  adminToken: 'admin',
  proxyKeys: [{ name: 'test-key', key: 'sk-local-test', enabled: true }],
  failoverStatusCodes: [401, 403, 408, 409, 429, 500, 502, 503, 504],
  requestTimeoutMs: 120000,
  circuitBreaker: {
    failureThreshold: 3,
    cooldownMinutes: 10,
    immediateCooldownStatusCodes: [429],
  },
  modelSource: {
    enabled: false,
    url: '',
    apiKey: '',
    refreshSeconds: 300,
    include: '',
    exclude: '',
    publicPrefix: '',
    publicSuffix: '',
    targets: [],
  },
  providers: [],
  models: [],
};

const initialState: State = {
  currentPage: 'dashboard',
  sidebarCollapsed: false,
  providers: [],
  chains: [],
  logs: [],
  adminToken: localStorage.getItem('adminToken') || 'admin',
  configLoaded: false,
  saveStatus: 'idle',
  saveError: '',
  backendConfig: null,
  backendStats: null,
  circuitFailureThreshold: 3,
  circuitCooldownMinutes: 10,
  targetTimeoutSeconds: 30,
  targetMaxRetries: 0,
};

function normalizeChainModels(models: FailoverChain['models']) {
  return [...models]
    .sort((a, b) => a.priority - b.priority)
    .map((model, index) => ({
      ...model,
      priority: index + 1,
      weight: 1,
      maxRetries: Math.max(0, Math.floor(Number(model.maxRetries) || 0)),
      timeout: Math.max(1, Math.floor(Number(model.timeout) || 30)),
      enabled: model.enabled !== false,
    }));
}

function normalizeChain(chain: FailoverChain): FailoverChain {
  return {
    ...chain,
    strategy: chain.strategy === 'weighted' ? 'priority' : chain.strategy || 'priority',
    concurrency: Math.max(1, Math.min(64, Math.floor(Number(chain.concurrency) || 1))),
    releaseDelaySeconds: Math.max(0, Math.min(3600, Math.floor(Number(chain.releaseDelaySeconds) || 0))),
    models: normalizeChainModels(chain.models || []),
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET_PAGE':
      return { ...state, currentPage: action.page };
    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case 'SET_ADMIN_TOKEN':
      localStorage.setItem('adminToken', action.token);
      return { ...state, adminToken: action.token };
    case 'SET_CIRCUIT_SETTINGS':
      return {
        ...state,
        circuitFailureThreshold: Math.max(1, Math.floor(Number(action.failureThreshold) || 3)),
        circuitCooldownMinutes: Math.max(1, Math.floor(Number(action.cooldownMinutes) || 10)),
      };
    case 'SET_TARGET_SETTINGS': {
      const timeout = Math.max(1, Math.floor(Number(action.timeoutSeconds) || 30));
      const maxRetries = Math.max(0, Math.floor(Number(action.maxRetries) || 0));
      return {
        ...state,
        targetTimeoutSeconds: timeout,
        targetMaxRetries: maxRetries,
        chains: state.chains.map(chain => ({
          ...chain,
          models: normalizeChainModels(chain.models.map(model => ({
            ...model,
            timeout,
            maxRetries,
            weight: 1,
          }))),
        })),
      };
    }
    case 'SET_SAVE_STATUS':
      return { ...state, saveStatus: action.status, saveError: action.error || '' };
    case 'LOAD_BACKEND_STATE': {
      const mapped = backendToUi(action.config, action.stats || null);
      const circuitBreaker = action.config.circuitBreaker || defaultConfig.circuitBreaker;
      const targetSettings = targetSettingsFromConfig(action.config);
      return {
        ...state,
        ...mapped,
        backendConfig: action.config,
        backendStats: action.stats || null,
        circuitFailureThreshold: Math.max(1, Number(circuitBreaker?.failureThreshold || 3)),
        circuitCooldownMinutes: Math.max(1, Number(circuitBreaker?.cooldownMinutes || 10)),
        targetTimeoutSeconds: targetSettings.timeoutSeconds,
        targetMaxRetries: targetSettings.maxRetries,
        configLoaded: true,
        saveStatus: 'idle',
        saveError: '',
      };
    }
    case 'LOAD_BACKEND_STATS':
      return applyStatsToState(state, action.stats);
    case 'ADD_PROVIDER':
      return { ...state, providers: [...state.providers, action.provider] };
    case 'UPDATE_PROVIDER':
      return { ...state, providers: state.providers.map(p => p.id === action.provider.id ? action.provider : p) };
    case 'DELETE_PROVIDER':
      return {
        ...state,
        providers: state.providers.filter(p => p.id !== action.id),
        chains: state.chains.map(chain => ({
          ...chain,
          models: normalizeChainModels(chain.models.filter(model => model.providerId !== action.id)),
        })),
      };
    case 'SET_PROVIDER_MODELS':
      return { ...state, providers: state.providers.map(p => p.id === action.id ? { ...p, models: action.models } : p) };
    case 'SET_PROVIDER_STATUS':
      return { ...state, providers: state.providers.map(p => p.id === action.id ? { ...p, status: action.status, latency: action.latency, lastCheck: Date.now() } : p) };
    case 'SET_PROVIDER_HEALTHS':
      return {
        ...state,
        providers: state.providers.map((provider) => {
          const health = action.providers.find((item) =>
            (item.id && item.id === provider.id) ||
            (item.baseUrl === provider.baseUrl && (!item.name || item.name === provider.name))
          );
          if (!health) return provider;
          return {
            ...provider,
            status: health.status,
            latency: health.latency,
            lastCheck: Date.now(),
          };
        }),
      };
    case 'ADD_CHAIN':
      return { ...state, chains: [...state.chains, normalizeChain(action.chain)] };
    case 'UPDATE_CHAIN':
      return { ...state, chains: state.chains.map(c => c.id === action.chain.id ? normalizeChain(action.chain) : c) };
    case 'DELETE_CHAIN':
      return { ...state, chains: state.chains.filter(c => c.id !== action.id) };
    case 'ADD_LOG':
      return { ...state, logs: [action.log, ...state.logs].slice(0, 200) };
    default:
      return state;
  }
}

function applyStatsToState(state: State, stats: BackendStats): State {
  return {
    ...state,
    backendStats: stats,
    chains: state.chains.map((chain) => {
      const modelStats = stats.chains?.[chain.proxyModelName];
      if (!modelStats) return chain;
      const totalFinished = modelStats.successes + modelStats.failures;
      const successRate = totalFinished ? Number(((modelStats.successes / totalFinished) * 100).toFixed(1)) : 100;
      return {
        ...chain,
        totalRequests: modelStats.requests,
        failoverCount: modelStats.failovers,
        successRate,
      };
    }),
    logs: (stats.logs || []).map((log) => ({
      id: log.id,
      timestamp: log.timestamp,
      chainName: log.chainName,
      originalModel: log.originalModel,
      failedModels: log.failedModels || [],
      finalModel: log.finalModel,
      status: log.status,
      latency: log.latency,
      error: log.error,
    })),
  };
}

function backendToUi(config: BackendConfig, stats?: BackendStats | null): Pick<State, 'providers' | 'chains' | 'logs'> {
  const providers: Provider[] = (config.providers || [])
    .filter((provider) => provider?.baseUrl)
    .map((provider) => ({
      id: provider.id || uuidv4(),
      name: provider.name || providerNameFromUrl(provider.baseUrl || ''),
      baseUrl: provider.baseUrl || '',
      apiKey: provider.apiKey || '',
      models: uniqueStrings(provider.models || []),
      status: 'unknown',
    }));
  const providerKeyToId = new Map<string, string>();
  const firstProxyKey = config.proxyKeys.find(key => key.enabled !== false)?.key || 'sk-local-test';

  providers.forEach((provider) => {
    providerKeyToId.set(providerKey(provider.baseUrl, provider.apiKey, provider.name), provider.id);
  });

  function ensureProvider(target: BackendTarget): string {
    const baseUrl = target.baseUrl || '';
    const apiKey = target.apiKey || '';
    const key = providerKey(baseUrl, apiKey, target.name || '');
    const existing = providerKeyToId.get(key);
    if (existing) return existing;

    const provider: Provider = {
      id: uuidv4(),
      name: target.name || providerNameFromUrl(baseUrl),
      baseUrl,
      apiKey,
      models: [],
      status: 'unknown',
    };
    providers.push(provider);
    providerKeyToId.set(key, provider.id);
    return provider.id;
  }

  const chains: FailoverChain[] = (config.models || []).map((model) => {
    const modelStats = stats?.chains?.[model.publicName];
    const totalRequests = modelStats?.requests || 0;
    const totalFinished = (modelStats?.successes || 0) + (modelStats?.failures || 0);
    const successRate = totalFinished ? Number((((modelStats?.successes || 0) / totalFinished) * 100).toFixed(1)) : 100;
    const models = (model.targets || []).map((target, index) => {
      const providerId = ensureProvider(target);
      const provider = providers.find(item => item.id === providerId);
      const modelName = target.modelName || target.modelNameTemplate || model.publicName;
      if (provider && modelName && !provider.models.includes(modelName)) {
        provider.models.push(modelName);
      }
      return {
        providerId,
        modelName,
        priority: Math.max(1, Math.floor(Number(target.priority) || index + 1)),
        weight: 1,
        maxRetries: Math.max(0, Math.floor(Number(target.maxRetries) || 0)),
        timeout: Math.max(1, Math.round((target.timeoutMs || config.requestTimeoutMs || 30000) / 1000)),
        enabled: target.enabled !== false,
      };
    }).sort((a, b) => a.priority - b.priority).map((item, index) => ({ ...item, priority: index + 1 }));

    return {
      id: uuidv4(),
      name: model.publicName,
      description: `代理模型 ${model.publicName}`,
      models,
      strategy: model.strategy === 'weighted' ? 'priority' : model.strategy || 'priority',
      proxyModelName: model.publicName,
      proxyApiKey: firstProxyKey,
      concurrency: Math.max(1, Math.min(64, Math.floor(Number(model.concurrency) || 1))),
      releaseDelaySeconds: Math.max(0, Math.min(3600, Math.round(Number(model.releaseDelayMs || 0) / 1000))),
      enabled: model.enabled !== false,
      createdAt: Date.now(),
      totalRequests,
      failoverCount: modelStats?.failovers || 0,
      successRate,
    };
  });

  const logs: LogEntry[] = (stats?.logs || []).map((log) => ({
    id: log.id,
    timestamp: log.timestamp,
    chainName: log.chainName,
    originalModel: log.originalModel,
    failedModels: log.failedModels || [],
    finalModel: log.finalModel,
    status: log.status,
    latency: log.latency,
    error: log.error,
  }));

  return { providers, chains, logs };
}

function providerKey(baseUrl: string, apiKey: string, name: string) {
  return `${baseUrl || ''}||${apiKey || ''}||${name || ''}`;
}

function uniqueStrings(items: string[]) {
  return [...new Set(items.map(String).filter(Boolean))];
}

function targetSettingsFromConfig(config: BackendConfig) {
  const firstTarget = (config.models || []).flatMap(model => model.targets || [])[0];
  return {
    timeoutSeconds: Math.max(1, Math.round((firstTarget?.timeoutMs || config.requestTimeoutMs || 30000) / 1000)),
    maxRetries: Math.max(0, Math.floor(Number(firstTarget?.maxRetries) || 0)),
  };
}

function uiToBackend(state: State): BackendConfig {
  const base = state.backendConfig || defaultConfig;
  const keyMap = new Map<string, string>();
  state.chains.forEach((chain, index) => {
    if (chain.proxyApiKey) keyMap.set(chain.proxyApiKey, chain.name || `chain-${index + 1}`);
  });

  const proxyKeys = Array.from(keyMap.entries()).map(([key, name]) => ({
    name,
    key,
    enabled: true,
  }));

  const models: BackendModel[] = state.chains.map((chain) => ({
    publicName: chain.proxyModelName,
    enabled: chain.enabled,
    strategy: chain.strategy,
    concurrency: Math.max(1, Math.min(64, Math.floor(Number(chain.concurrency) || 1))),
    releaseDelayMs: Math.max(0, Math.min(3600, Math.floor(Number(chain.releaseDelaySeconds) || 0))) * 1000,
    targets: [...chain.models]
      .sort((a, b) => a.priority - b.priority)
      .map((model, index) => {
        const provider = state.providers.find(item => item.id === model.providerId);
        return {
          name: provider?.name || model.modelName,
          baseUrl: provider?.baseUrl || '',
          apiKey: provider?.apiKey || '',
          modelName: model.modelName,
          enabled: model.enabled,
          priority: index + 1,
          weight: 1,
          maxRetries: Math.max(0, Math.floor(Number(state.targetMaxRetries) || 0)),
          timeoutMs: Math.max(1, Math.floor(Number(state.targetTimeoutSeconds) || 30)) * 1000,
        };
      })
      .filter(target => target.baseUrl && target.apiKey && target.modelName),
  }));

  const providers: BackendProvider[] = state.providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    models: uniqueStrings(provider.models || []),
  }));

  return {
    ...base,
    adminToken: state.adminToken || base.adminToken || 'admin',
    proxyKeys: proxyKeys.length ? proxyKeys : base.proxyKeys,
    circuitBreaker: {
      failureThreshold: Math.max(1, Math.floor(Number(state.circuitFailureThreshold) || 3)),
      cooldownMinutes: Math.max(1, Math.floor(Number(state.circuitCooldownMinutes) || 10)),
      immediateCooldownStatusCodes: base.circuitBreaker?.immediateCooldownStatusCodes || [429],
    },
    providers,
    models,
  };
}

function providerNameFromUrl(baseUrl: string) {
  try {
    return new URL(baseUrl).hostname.replace(/^api\./, '');
  } catch {
    return baseUrl || 'Provider';
  }
}

async function readJsonError(res: Response) {
  const body = await res.json().catch(() => null);
  return body?.error?.message || `${res.status} ${res.statusText}`;
}

const StoreContext = createContext<{
  state: State;
  dispatch: React.Dispatch<Action>;
  loadConfig: (tokenOverride?: string) => Promise<void>;
  saveConfig: (tokenOverride?: string) => Promise<void>;
  fetchProviderModels: (url: string, apiKey: string) => Promise<string[]>;
  refreshProviderHealth: () => Promise<void>;
  runModelTests: (targets: ModelTestTarget[], capabilities: ModelCapability[]) => Promise<ModelTestResult[]>;
} | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const loadConfig = useCallback(async (tokenOverride?: string) => {
    const token = tokenOverride || state.adminToken;
    dispatch({ type: 'SET_SAVE_STATUS', status: 'loading' });
    const res = await fetch('/api/config', {
      headers: { 'x-admin-token': token },
    });
    if (!res.ok) {
      const message = await readJsonError(res);
      dispatch({ type: 'SET_SAVE_STATUS', status: 'error', error: message });
      throw new Error(message);
    }
    const config = await res.json();
    const stats = await fetch('/api/stats', {
      headers: { 'x-admin-token': token },
    }).then((statsRes) => statsRes.ok ? statsRes.json() : null).catch(() => null);
    dispatch({ type: 'LOAD_BACKEND_STATE', config, stats });
  }, [state.adminToken]);

  const saveConfig = useCallback(async (tokenOverride?: string) => {
    const token = tokenOverride || state.adminToken;
    dispatch({ type: 'SET_SAVE_STATUS', status: 'saving' });
    const nextConfig = uiToBackend({ ...state, adminToken: token });
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': token,
      },
      body: JSON.stringify(nextConfig),
    });
    if (!res.ok) {
      const message = await readJsonError(res);
      dispatch({ type: 'SET_SAVE_STATUS', status: 'error', error: message });
      throw new Error(message);
    }
    const body = await res.json();
    const stats = await fetch('/api/stats', {
      headers: { 'x-admin-token': token },
    }).then((statsRes) => statsRes.ok ? statsRes.json() : null).catch(() => null);
    dispatch({ type: 'LOAD_BACKEND_STATE', config: body.config, stats });
    dispatch({ type: 'SET_SAVE_STATUS', status: 'saved' });
  }, [state]);

  const fetchProviderModels = useCallback(async (url: string, apiKey: string) => {
    const res = await fetch('/api/model-source/preview', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': state.adminToken,
      },
      body: JSON.stringify({ url, apiKey }),
    });
    if (!res.ok) throw new Error(await readJsonError(res));
    const body = await res.json();
    return body.models || [];
  }, [state.adminToken]);

  const providerHealthSignature = useMemo(
    () => state.providers.map((provider) => `${provider.id}:${provider.name}:${provider.baseUrl}:${provider.apiKey}`).join('|'),
    [state.providers]
  );

  const providerHealthRequest = useMemo(
    () => state.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
    })),
    [providerHealthSignature]
  );

  const refreshProviderHealth = useCallback(async () => {
    if (!state.configLoaded || !providerHealthRequest.length) return;
    const res = await fetch('/api/providers/health', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': state.adminToken,
      },
      body: JSON.stringify({ providers: providerHealthRequest }),
    });
    if (!res.ok) throw new Error(await readJsonError(res));
    const body = await res.json();
    dispatch({ type: 'SET_PROVIDER_HEALTHS', providers: body.providers || [] });
  }, [state.adminToken, state.configLoaded, providerHealthRequest]);

  const runModelTests = useCallback(async (targets: ModelTestTarget[], capabilities: ModelCapability[]) => {
    const res = await fetch('/api/model-tests/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': state.adminToken,
      },
      body: JSON.stringify({ targets, capabilities }),
    });
    if (!res.ok) throw new Error(await readJsonError(res));
    const body = await res.json();
    return body.results || [];
  }, [state.adminToken]);

  useEffect(() => {
    loadConfig().catch(() => undefined);
  }, [loadConfig]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!state.configLoaded) return;
      fetch('/api/stats', { headers: { 'x-admin-token': state.adminToken } })
        .then((res) => res.ok ? res.json() : null)
        .then((stats) => {
          if (stats) dispatch({ type: 'LOAD_BACKEND_STATS', stats });
        })
        .catch(() => undefined);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [state.configLoaded, state.adminToken]);

  useEffect(() => {
    if (!state.configLoaded || !state.providers.length) return;
    refreshProviderHealth().catch(() => undefined);
    const timer = window.setInterval(() => {
      refreshProviderHealth().catch(() => undefined);
    }, 30000);
    return () => window.clearInterval(timer);
  }, [state.configLoaded, providerHealthSignature, refreshProviderHealth]);

  return (
    <StoreContext.Provider value={{ state, dispatch, loadConfig, saveConfig, fetchProviderModels, refreshProviderHealth, runModelTests }}>
      {children}
    </StoreContext.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}
