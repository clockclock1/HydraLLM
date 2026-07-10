export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  status: 'online' | 'offline' | 'unknown';
  latency?: number;
  lastCheck?: number;
}

export interface FailoverModel {
  providerId: string;
  modelName: string;
  priority: number;
  weight: number;
  maxRetries: number;
  timeout: number;
  enabled: boolean;
}

export interface FailoverChain {
  id: string;
  name: string;
  description: string;
  models: FailoverModel[];
  strategy: 'priority' | 'round-robin' | 'weighted' | 'latency-based';
  proxyModelName: string;
  proxyApiKey: string;
  concurrency: number;
  releaseDelaySeconds: number;
  enabled: boolean;
  createdAt: number;
  totalRequests: number;
  failoverCount: number;
  successRate: number;
}

export type Page = 'dashboard' | 'providers' | 'model-tests' | 'chains' | 'endpoints' | 'logs' | 'settings';

export interface LogEntry {
  id: string;
  timestamp: number;
  chainName: string;
  originalModel: string;
  failedModels: string[];
  finalModel: string;
  status: 'success' | 'failed';
  latency: number;
  error?: string;
}

export type ModelCapability = 'text' | 'vision' | 'tool';
export type ModelTestStatus = 'passed' | 'failed' | 'uncertain' | 'skipped';

export interface ModelTestTarget {
  id: string;
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

export interface ModelCapabilityResult {
  capability: ModelCapability;
  status: ModelTestStatus;
  latencyMs?: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  detail: string;
  evidence?: string;
}

export interface ModelTestResult {
  id: string;
  providerId: string;
  providerName: string;
  baseUrl: string;
  modelName: string;
  startedAt: number;
  latencyMs: number;
  results: ModelCapabilityResult[];
}
