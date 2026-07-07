import React, { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { Provider, FailoverChain, Page, LogEntry } from './types';

interface BackendTarget {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  modelName?: string;
  modelNameTemplate?: string;
  enabled?: boolean;
  timeoutMs?: number;
}

interface BackendModel {
  publicName: string;
  enabled?: boolean;
  targets?: BackendTarget[];
}

interface BackendConfig {
  adminToken: string;
  proxyKeys: { name?: string; key: string; enabled?: boolean }[];
  failoverStatusCodes: number[];
  requestTimeoutMs: number;
  modelSource?: unknown;
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
}

type Action =
  | { type: 'SET_PAGE'; page: Page }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_ADMIN_TOKEN'; token: string }
  | { type: 'SET_SAVE_STATUS'; status: State['saveStatus']; error?: string }
  | { type: 'LOAD_BACKEND_STATE'; config: BackendConfig; stats?: BackendStats | null }
  | { type: 'LOAD_BACKEND_STATS'; stats: BackendStats }
  | { type: 'ADD_PROVIDER'; provider: Provider }
  | { type: 'UPDATE_PROVIDER'; provider: Provider }
  | { type: 'DELETE_PROVIDER'; id: string }
  | { type: 'SET_PROVIDER_MODELS'; id: string; models: string[] }
  | { type: 'SET_PROVIDER_STATUS'; id: string; status: Provider['status']; latency?: number }
  | { type: 'ADD_CHAIN'; chain: FailoverChain }
  | { type: 'UPDATE_CHAIN'; chain: FailoverChain }
  | { type: 'DELETE_CHAIN'; id: string }
  | { type: 'ADD_LOG'; log: LogEntry };

const defaultConfig: BackendConfig = {
  adminToken: 'admin',
  proxyKeys: [{ name: 'test-key', key: 'sk-local-test', enabled: true }],
  failoverStatusCodes: [401, 403, 408, 409, 429, 500, 502, 503, 504],
  requestTimeoutMs: 120000,
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
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET_PAGE':
      return { ...state, currentPage: action.page };
    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case 'SET_ADMIN_TOKEN':
      localStorage.setItem('adminToken', action.token);
      return { ...state, adminToken: action.token };
    case 'SET_SAVE_STATUS':
      return { ...state, saveStatus: action.status, saveError: action.error || '' };
    case 'LOAD_BACKEND_STATE': {
      const mapped = backendToUi(action.config, action.stats || null);
      return {
        ...state,
        ...mapped,
        backendConfig: action.config,
        backendStats: action.stats || null,
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
          models: chain.models.filter(model => model.providerId !== action.id),
        })),
      };
    case 'SET_PROVIDER_MODELS':
      return { ...state, providers: state.providers.map(p => p.id === action.id ? { ...p, models: action.models } : p) };
    case 'SET_PROVIDER_STATUS':
      return { ...state, providers: state.providers.map(p => p.id === action.id ? { ...p, status: action.status, latency: action.latency, lastCheck: Date.now() } : p) };
    case 'ADD_CHAIN':
      return { ...state, chains: [...state.chains, action.chain] };
    case 'UPDATE_CHAIN':
      return { ...state, chains: state.chains.map(c => c.id === action.chain.id ? action.chain : c) };
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
  const providers: Provider[] = [];
  const providerKeyToId = new Map<string, string>();
  const firstProxyKey = config.proxyKeys.find(key => key.enabled !== false)?.key || 'sk-local-test';

  function ensureProvider(target: BackendTarget): string {
    const baseUrl = target.baseUrl || '';
    const apiKey = target.apiKey || '';
    const key = `${baseUrl}||${apiKey}||${target.name || ''}`;
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
        priority: index + 1,
        weight: Math.max(1, Math.floor(100 / Math.max(1, model.targets?.length || 1))),
        maxRetries: 1,
        timeout: Math.max(1, Math.round((target.timeoutMs || config.requestTimeoutMs || 30000) / 1000)),
        enabled: target.enabled !== false,
      };
    });

    return {
      id: uuidv4(),
      name: model.publicName,
      description: `代理模型 ${model.publicName}`,
      models,
      strategy: 'priority',
      proxyModelName: model.publicName,
      proxyApiKey: firstProxyKey,
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
    targets: chain.models
      .sort((a, b) => a.priority - b.priority)
      .map((model) => {
        const provider = state.providers.find(item => item.id === model.providerId);
        return {
          name: provider?.name || model.modelName,
          baseUrl: provider?.baseUrl || '',
          apiKey: provider?.apiKey || '',
          modelName: model.modelName,
          enabled: model.enabled,
          timeoutMs: Math.max(1, model.timeout || 30) * 1000,
        };
      })
      .filter(target => target.baseUrl && target.apiKey && target.modelName),
  }));

  return {
    ...base,
    adminToken: state.adminToken || base.adminToken || 'admin',
    proxyKeys: proxyKeys.length ? proxyKeys : base.proxyKeys,
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
} | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const loadConfig = async (tokenOverride?: string) => {
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
  };

  const saveConfig = async (tokenOverride?: string) => {
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
  };

  const fetchProviderModels = async (url: string, apiKey: string) => {
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
  };

  useEffect(() => {
    loadConfig().catch(() => undefined);
  }, []);

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

  return (
    <StoreContext.Provider value={{ state, dispatch, loadConfig, saveConfig, fetchProviderModels }}>
      {children}
    </StoreContext.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}
