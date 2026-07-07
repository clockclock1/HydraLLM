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
  enabled: boolean;
  createdAt: number;
  totalRequests: number;
  failoverCount: number;
  successRate: number;
}

export type Page = 'dashboard' | 'providers' | 'chains' | 'endpoints' | 'logs';

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
