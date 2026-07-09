import http from "node:http";
import { readFile, writeFile, mkdir, stat, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = process.pkg ? path.dirname(process.execPath) : __dirname;
const publicDir = process.pkg ? path.join(__dirname, "public") : path.join(__dirname, "public");
const dataDir = process.env.DATA_DIR || path.join(runtimeDir, "data");
const configPath = process.env.CONFIG_PATH || path.join(dataDir, "config.json");
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 8787);
const bodyLimitBytes = Number(process.env.BODY_LIMIT_MB || 50) * 1024 * 1024;
const streamFailureProbeBytes = Number(process.env.STREAM_FAILURE_PROBE_KB || 64) * 1024;

const jsonType = { "content-type": "application/json; charset=utf-8" };
const textType = { "content-type": "text/plain; charset=utf-8" };
const staticTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const stats = {
  startedAt: new Date().toISOString(),
  requests: 0,
  successes: 0,
  failures: 0,
  failovers: 0,
  targets: {},
  chains: {},
  logs: []
};

const circuitBreakers = new Map();
const roundRobinCursors = new Map();
const validStrategies = new Set(["priority", "round-robin", "weighted", "latency-based"]);

const defaultConfig = {
  adminToken: "admin",
  proxyKeys: [
    {
      name: "test-key",
      key: "sk-local-test",
      enabled: true
    }
  ],
  failoverStatusCodes: [401, 403, 408, 409, 429, 500, 502, 503, 504],
  requestTimeoutMs: 120000,
  circuitBreaker: {
    failureThreshold: 3,
    cooldownMinutes: 10,
    immediateCooldownStatusCodes: [429]
  },
  modelSource: {
    enabled: false,
    url: "",
    apiKey: "",
    refreshSeconds: 300,
    include: "",
    exclude: "",
    publicPrefix: "",
    publicSuffix: "",
    targets: [
      {
        name: "primary-openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-replace-me",
        modelNameTemplate: "{model}",
        enabled: true
      },
      {
        name: "backup-openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-replace-me-too",
        modelNameTemplate: "{model}",
        enabled: false
      }
    ]
  },
  models: [
    {
      publicName: "gpt-failover",
      enabled: true,
      targets: [
        {
          name: "primary-openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-replace-me",
          modelName: "gpt-4.1-mini",
          enabled: true
        },
        {
          name: "backup-openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-replace-me-too",
          modelName: "gpt-4o-mini",
          enabled: false
        }
      ]
    }
  ]
};

let configCache = null;
const modelSourceCache = {
  cacheKey: "",
  fetchedAt: 0,
  models: [],
  error: ""
};

async function ensureConfig() {
  await mkdir(dataDir, { recursive: true });
  try {
    await stat(configPath);
  } catch {
    await writeFile(configPath, JSON.stringify(defaultConfig, null, 2), "utf8");
  }
}

async function loadConfig() {
  await ensureConfig();
  const text = await readFile(configPath, "utf8");
  configCache = normalizeConfig(JSON.parse(text));
  return configCache;
}

async function saveConfig(nextConfig) {
  const normalized = normalizeConfig(nextConfig);
  await mkdir(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(normalized, null, 2), "utf8");
  await rename(tmpPath, configPath);
  configCache = normalized;
}

function normalizeConfig(input) {
  const cfg = structuredClone(input || {});
  cfg.adminToken = String(cfg.adminToken || defaultConfig.adminToken);
  cfg.proxyKeys = Array.isArray(cfg.proxyKeys) ? cfg.proxyKeys : [];
  cfg.failoverStatusCodes = Array.isArray(cfg.failoverStatusCodes)
    ? cfg.failoverStatusCodes.map(Number)
    : defaultConfig.failoverStatusCodes;
  cfg.requestTimeoutMs = Number(cfg.requestTimeoutMs || defaultConfig.requestTimeoutMs);
  cfg.circuitBreaker = normalizeCircuitBreaker(cfg.circuitBreaker);
  cfg.models = Array.isArray(cfg.models) ? cfg.models.map(normalizeModelConfig) : [];
  cfg.modelSource = normalizeModelSource(cfg.modelSource);
  cfg.providers = normalizeProviders(cfg.providers);
  return cfg;
}

function normalizeModelConfig(model) {
  const normalized = { ...(model || {}) };
  normalized.publicName = String(normalized.publicName || "");
  normalized.enabled = normalized.enabled !== false;
  normalized.strategy = validStrategies.has(normalized.strategy) ? normalized.strategy : "priority";
  normalized.targets = normalizeTargetQueue(normalized.targets);
  return normalized;
}

function normalizeTargetQueue(targets) {
  return (Array.isArray(targets) ? targets : [])
    .map((target, index) => ({
      ...(target || {}),
      priority: Math.max(1, Math.floor(Number(target?.priority) || index + 1)),
      weight: Math.max(1, Math.floor(Number(target?.weight) || 1)),
      maxRetries: Math.max(0, Math.floor(Number(target?.maxRetries) || 0)),
      timeoutMs: Math.max(1, Number(target?.timeoutMs || defaultConfig.requestTimeoutMs)),
      enabled: target?.enabled !== false
    }))
    .sort((a, b) => a.priority - b.priority)
    .map((target, index) => ({ ...target, priority: index + 1 }));
}

function normalizeProviders(providers) {
  return (Array.isArray(providers) ? providers : [])
    .map((provider) => ({
      id: String(provider?.id || ""),
      name: String(provider?.name || ""),
      baseUrl: String(provider?.baseUrl || "").replace(/\/+$/, ""),
      apiKey: String(provider?.apiKey || ""),
      models: uniqueStrings(provider?.models || [])
    }))
    .filter((provider) => provider.baseUrl);
}

function uniqueStrings(items) {
  return [...new Set((Array.isArray(items) ? items : []).map(String).filter(Boolean))];
}

function normalizeCircuitBreaker(input) {
  const breaker = { ...defaultConfig.circuitBreaker, ...(input || {}) };
  breaker.failureThreshold = Math.max(1, Number(breaker.failureThreshold || defaultConfig.circuitBreaker.failureThreshold));
  breaker.cooldownMinutes = Math.max(1, Number(breaker.cooldownMinutes || defaultConfig.circuitBreaker.cooldownMinutes));
  breaker.immediateCooldownStatusCodes = Array.isArray(breaker.immediateCooldownStatusCodes)
    ? breaker.immediateCooldownStatusCodes.map(Number).filter((item) => Number.isFinite(item))
    : defaultConfig.circuitBreaker.immediateCooldownStatusCodes;
  return breaker;
}

function normalizeModelSource(input) {
  const source = { ...defaultConfig.modelSource, ...(input || {}) };
  source.enabled = source.enabled === true;
  source.url = String(source.url || "");
  source.apiKey = String(source.apiKey || "");
  source.refreshSeconds = Number(source.refreshSeconds || defaultConfig.modelSource.refreshSeconds);
  source.include = String(source.include || "");
  source.exclude = String(source.exclude || "");
  source.publicPrefix = String(source.publicPrefix || "");
  source.publicSuffix = String(source.publicSuffix || "");
  source.targets = normalizeTargetQueue(source.targets);
  return source;
}

function withCors(headers = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-admin-token",
    "access-control-expose-headers": "content-type,x-proxy-target,x-proxy-model",
    ...headers
  };
}

function send(res, statusCode, body, headers = jsonType) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(statusCode, withCors(headers));
  res.end(payload);
}

function sendError(res, statusCode, message, details) {
  send(res, statusCode, {
    error: {
      message,
      type: "proxy_error",
      details
    }
  });
}

function authBearer(req) {
  const raw = req.headers.authorization || "";
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function isAdmin(req, cfg) {
  const headerToken = String(req.headers["x-admin-token"] || "");
  return headerToken === cfg.adminToken || authBearer(req) === cfg.adminToken;
}

function isProxyKey(req, cfg) {
  const token = authBearer(req);
  return cfg.proxyKeys.some((item) => item.enabled !== false && item.key === token);
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > bodyLimitBytes) {
      const err = new Error(`Request body exceeds ${Math.floor(bodyLimitBytes / 1024 / 1024)} MB`);
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  return JSON.parse(text);
}

function endpointSuffix(pathname) {
  const cleaned = pathname.replace(/^\/+/, "");
  return cleaned.startsWith("v1/") ? cleaned.slice(3) : cleaned;
}

function isCompletionEndpoint(pathname) {
  return [
    "/v1/chat/completions",
    "/chat/completions",
    "/v1/responses",
    "/responses",
    "/v1/completions",
    "/completions"
  ].includes(pathname);
}

async function findModel(cfg, publicName) {
  const models = await runtimeModels(cfg);
  return models.find((model) => model.enabled !== false && model.publicName === publicName);
}

function enabledTargets(model) {
  const configured = normalizeTargetQueue(model.targets).filter((target) => target.enabled !== false && target.baseUrl && target.apiKey);
  const available = configured.filter((target) => !isCircuitOpen(model, target));
  if (!configured.length || available.length) return selectTargetQueue(model, available);

  resetModelCircuits(model);
  return selectTargetQueue(model, configured);
}

function selectTargetQueue(model, targets) {
  const ordered = [...targets].sort((a, b) => a.priority - b.priority);
  if (ordered.length <= 1) return ordered;

  if (model.strategy === "round-robin") {
    const key = model.publicName;
    const cursor = roundRobinCursors.get(key) || 0;
    roundRobinCursors.set(key, (cursor + 1) % ordered.length);
    return rotateTargets(ordered, cursor % ordered.length);
  }

  if (model.strategy === "weighted") {
    const totalWeight = ordered.reduce((sum, target) => sum + Math.max(1, Number(target.weight) || 1), 0);
    let ticket = Math.random() * totalWeight;
    const startIndex = ordered.findIndex((target) => {
      ticket -= Math.max(1, Number(target.weight) || 1);
      return ticket <= 0;
    });
    return rotateTargets(ordered, Math.max(0, startIndex));
  }

  if (model.strategy === "latency-based") {
    return ordered.sort((a, b) => targetAverageLatency(model, a) - targetAverageLatency(model, b) || a.priority - b.priority);
  }

  return ordered;
}

function rotateTargets(targets, startIndex) {
  return [...targets.slice(startIndex), ...targets.slice(0, startIndex)];
}

function targetAverageLatency(model, target) {
  const key = targetKey(model, target);
  const latency = Number(stats.targets[key]?.avgLatencyMs || 0);
  return latency > 0 ? latency : Number.MAX_SAFE_INTEGER;
}

function targetKey(model, target) {
  return `${model.publicName}/${target.name || ""}/${target.modelName || ""}/${target.baseUrl || ""}`;
}

function recordTarget(model, target, ok, cfg, failure = {}, latencyMs = 0) {
  const key = targetKey(model, target);
  const failureThreshold = cfg?.circuitBreaker?.failureThreshold || defaultConfig.circuitBreaker.failureThreshold;
  const cooldownMs = (cfg?.circuitBreaker?.cooldownMinutes || defaultConfig.circuitBreaker.cooldownMinutes) * 60 * 1000;
  const immediateCooldownStatusCodes = cfg?.circuitBreaker?.immediateCooldownStatusCodes || defaultConfig.circuitBreaker.immediateCooldownStatusCodes;
  stats.targets[key] ||= {
    model: model.publicName,
    target: target.name || target.modelName || target.baseUrl,
    upstreamModel: target.modelName || "",
    baseUrl: target.baseUrl || "",
    ok: 0,
    error: 0,
    consecutiveFailures: 0,
    disabledUntil: 0,
    lastStatus: 0,
    lastError: "",
    lastLatencyMs: 0,
    avgLatencyMs: 0
  };
  const measuredLatency = Math.max(0, Math.round(Number(latencyMs) || 0));
  if (measuredLatency > 0) {
    stats.targets[key].lastLatencyMs = measuredLatency;
    stats.targets[key].avgLatencyMs = stats.targets[key].avgLatencyMs
      ? Math.round((stats.targets[key].avgLatencyMs * 0.8) + (measuredLatency * 0.2))
      : measuredLatency;
  }
  if (ok) {
    stats.targets[key].ok += 1;
    stats.targets[key].consecutiveFailures = 0;
    stats.targets[key].lastStatus = 0;
    stats.targets[key].lastError = "";
    circuitBreakers.delete(key);
  } else {
    stats.targets[key].error += 1;
    const breaker = circuitBreakers.get(key) || { failures: 0, disabledUntil: 0 };
    breaker.failures += 1;
    if (breaker.failures >= failureThreshold || immediateCooldownStatusCodes.includes(Number(failure.status))) {
      breaker.disabledUntil = Date.now() + cooldownMs;
    }
    circuitBreakers.set(key, breaker);
    stats.targets[key].consecutiveFailures = breaker.failures;
    stats.targets[key].disabledUntil = breaker.disabledUntil || 0;
  }
}

function recordTargetFailure(model, target, cfg, failure, latencyMs = 0) {
  recordTarget(model, target, false, cfg, failure, latencyMs);
  const key = targetKey(model, target);
  if (stats.targets[key]) {
    stats.targets[key].lastStatus = Number(failure?.status || 0);
    stats.targets[key].lastError = failure?.message || failure?.body || "";
  }
}

function upstreamUrl(target, pathname) {
  const base = target.baseUrl.replace(/\/+$/, "");
  return `${base}/${endpointSuffix(pathname)}`;
}

function shouldTryNext(statusCode, cfg) {
  const status = Number(statusCode);
  return status >= 400 || cfg.failoverStatusCodes.includes(status);
}

function classifyUpstreamFailure(statusCode, text, responseOk) {
  const status = Number(statusCode || 0);
  const body = String(text || "");
  const parsed = parseJsonSafe(body);
  let embedded = embeddedError(parsed, body);
  if (!embedded.message && embedded.status < 400) {
    embedded = embeddedStreamError(body);
  }

  if (!responseOk) {
    return {
      status,
      retryable: true,
      message: embedded.message || `Upstream returned ${status}`,
      body: trimError(body)
    };
  }

  if (embedded.message) {
    return {
      status: embedded.status || status || 500,
      retryable: true,
      message: embedded.message,
      body: trimError(body)
    };
  }

  return null;
}

function parseJsonSafe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function embeddedError(payload, text) {
  const hasExplicitError = payload && (
    Object.prototype.hasOwnProperty.call(payload, "error") ||
    Object.prototype.hasOwnProperty.call(payload, "error_message") ||
    Object.prototype.hasOwnProperty.call(payload, "status_code")
  );
  const error = payload?.error || payload?.detail?.error || payload?.details?.error;
  const message = [
    typeof error === "string" ? error : "",
    error?.message,
    hasExplicitError ? payload?.message : "",
    payload?.detail,
    payload?.error_message,
    payload?.error?.details
  ].find((item) => typeof item === "string" && item.trim());

  const rawStatus = error?.status || error?.status_code || error?.code || payload?.status || payload?.status_code;
  const numericStatus = Number(rawStatus);
  const regexStatus = String(text || "").match(/\b(?:returned|status|code|http)\s*:?\s*(\d{3})\b/i);
  const status = Number.isFinite(numericStatus) && numericStatus >= 400 ? numericStatus : Number(regexStatus?.[1] || 0);

  if (message || status >= 400) {
    return {
      status: status >= 400 ? status : 0,
      message: message || `Upstream returned ${status}`
    };
  }

  return { status: 0, message: "" };
}

function embeddedStreamError(text) {
  const body = String(text || "");
  const events = parseSseDataPayloads(body);
  for (const event of events) {
    const parsed = parseJsonSafe(event);
    const embedded = embeddedError(parsed, event);
    if (embedded.message || embedded.status >= 400) return embedded;
  }
  return { status: 0, message: "" };
}

function parseSseDataPayloads(text) {
  const events = [];
  let current = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) {
      if (current.length) {
        events.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    if (line.startsWith("data:")) {
      const data = line.slice(5).trimStart();
      if (data && data !== "[DONE]") current.push(data);
    }
  }
  if (current.length) events.push(current.join("\n"));
  return events;
}

function streamProbeComplete(text) {
  return /\r?\n\r?\n/.test(String(text || "")) || String(text || "").length >= streamFailureProbeBytes;
}

async function inspectInitialStream(upstream) {
  if (!upstream.body) {
    return { reader: null, chunks: [], failure: null };
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let text = "";

  while (text.length < streamFailureProbeBytes) {
    const { done, value } = await reader.read();
    if (done) {
      text += decoder.decode();
      return {
        reader,
        chunks,
        failure: classifyUpstreamFailure(upstream.status, text, upstream.ok)
      };
    }

    chunks.push(value);
    text += decoder.decode(value, { stream: true });

    const failure = classifyUpstreamFailure(upstream.status, text, upstream.ok);
    if (failure) {
      return { reader, chunks, failure };
    }

    if (streamProbeComplete(text)) {
      return { reader, chunks, failure: null };
    }
  }

  return { reader, chunks, failure: null };
}

function isCircuitOpen(model, target) {
  const key = targetKey(model, target);
  const breaker = circuitBreakers.get(key);
  if (!breaker?.disabledUntil) return false;
  if (Date.now() >= breaker.disabledUntil) {
    circuitBreakers.delete(key);
    if (stats.targets[key]) {
      stats.targets[key].consecutiveFailures = 0;
      stats.targets[key].disabledUntil = 0;
    }
    return false;
  }
  return true;
}

function resetModelCircuits(model) {
  for (const target of model.targets || []) {
    const key = targetKey(model, target);
    circuitBreakers.delete(key);
    if (stats.targets[key]) {
      stats.targets[key].consecutiveFailures = 0;
      stats.targets[key].disabledUntil = 0;
    }
  }
}

function chainStats(model) {
  stats.chains[model.publicName] ||= {
    requests: 0,
    successes: 0,
    failures: 0,
    failovers: 0
  };
  return stats.chains[model.publicName];
}

function addLog(entry) {
  stats.logs.unshift({
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    ...entry
  });
  stats.logs = stats.logs.slice(0, 500);
}

function sourceCacheKey(source) {
  return [
    source.enabled,
    source.url,
    source.apiKey ? "with-key" : "no-key",
    source.include,
    source.exclude,
    source.publicPrefix,
    source.publicSuffix
  ].join("|");
}

async function runtimeModels(cfg) {
  const explicitModels = cfg.models.filter((model) => model.enabled !== false);
  const sourceModels = await sourceRuntimeModels(cfg).catch((err) => {
    modelSourceCache.error = err.message;
    return [];
  });
  const seen = new Set();
  return [...explicitModels, ...sourceModels].filter((model) => {
    if (seen.has(model.publicName)) return false;
    seen.add(model.publicName);
    return true;
  });
}

async function sourceRuntimeModels(cfg, force = false) {
  const source = cfg.modelSource;
  if (!source?.enabled || !source.url) return [];

  const cacheKey = sourceCacheKey(source);
  const maxAgeMs = Math.max(1, source.refreshSeconds) * 1000;
  if (!force && modelSourceCache.cacheKey === cacheKey && Date.now() - modelSourceCache.fetchedAt < maxAgeMs) {
    return modelSourceCache.models;
  }

  const remoteModels = await fetchModelSource(source);
  const filtered = filterSourceModels(remoteModels, source);
  const generated = filtered.map((item) => {
    const publicName = `${source.publicPrefix}${item.id}${source.publicSuffix}`;
    return {
      publicName,
      enabled: true,
      sourceModelName: item.id,
      targets: source.targets.map((target) => ({
        ...target,
        modelName: resolveTargetModelName(target, item.id)
      }))
    };
  });

  modelSourceCache.cacheKey = cacheKey;
  modelSourceCache.fetchedAt = Date.now();
  modelSourceCache.models = generated;
  modelSourceCache.error = "";
  return generated;
}

async function fetchModelSource(source) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const headers = { accept: "application/json" };
  if (source.apiKey) headers.authorization = `Bearer ${source.apiKey}`;

  try {
    const res = await fetch(source.url, { headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`Model source returned ${res.status}: ${trimError(text)}`);
    return extractSourceModels(JSON.parse(text));
  } finally {
    clearTimeout(timeout);
  }
}

async function checkProviderHealth(provider) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(provider.timeoutMs || 10000));
  const baseUrl = String(provider.baseUrl || "").replace(/\/+$/, "");
  const headers = { accept: "application/json" };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  try {
    if (!baseUrl) throw new Error("missing baseUrl");
    const res = await fetch(`${baseUrl}/models`, { headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${trimError(text)}`);
    const models = extractSourceModels(JSON.parse(text)).map((item) => item.id);
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      status: "online",
      latency: Date.now() - startedAt,
      models,
      error: ""
    };
  } catch (err) {
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      status: "offline",
      latency: Date.now() - startedAt,
      models: [],
      error: err.name === "AbortError" ? "timeout" : err.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeTestCapabilities(items) {
  const allowed = new Set(["text", "vision", "tool"]);
  const requested = Array.isArray(items) ? items.map(String).filter((item) => allowed.has(item)) : [];
  return requested.length ? [...new Set(requested)] : ["text", "vision", "tool"];
}

function normalizeTestTargets(items) {
  return (Array.isArray(items) ? items : [])
    .map((target) => ({
      id: String(target?.id || ""),
      providerId: String(target?.providerId || ""),
      providerName: String(target?.providerName || target?.name || ""),
      baseUrl: String(target?.baseUrl || "").replace(/\/+$/, ""),
      apiKey: String(target?.apiKey || ""),
      modelName: String(target?.modelName || "")
    }))
    .filter((target) => target.baseUrl && target.modelName);
}

async function handleModelTests(req, res) {
  try {
    const body = await readJson(req);
    const targets = normalizeTestTargets(body.targets).slice(0, 50);
    const capabilities = normalizeTestCapabilities(body.capabilities);
    if (!targets.length) {
      sendError(res, 400, "No testable models were provided");
      return;
    }

    const results = await runWithConcurrency(targets, 3, (target) => testModelCapabilities(target, capabilities));
    send(res, 200, { ok: true, results });
  } catch (err) {
    sendError(res, 400, err.message || "Cannot run model tests");
  }
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function testModelCapabilities(target, capabilities) {
  const startedAt = Date.now();
  const results = [];
  for (const capability of capabilities) {
    results.push(await runCapabilityTest(target, capability));
  }
  return {
    id: target.id || `${target.providerId}:${target.modelName}`,
    providerId: target.providerId,
    providerName: target.providerName || target.baseUrl,
    baseUrl: target.baseUrl,
    modelName: target.modelName,
    startedAt,
    latencyMs: Date.now() - startedAt,
    results
  };
}

async function runCapabilityTest(target, capability) {
  if (capability === "text") return testTextCompletion(target);
  if (capability === "vision") return testVision(target);
  if (capability === "tool") return testToolCalling(target);
  return {
    capability,
    status: "skipped",
    detail: "Unknown capability"
  };
}

async function callTestChat(target, body, timeoutMs = 45000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    "content-type": "application/json",
    "authorization": `Bearer ${target.apiKey}`
  };

  try {
    const res = await fetch(`${target.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, model: target.modelName }),
      signal: controller.signal
    });
    const text = await res.text();
    const payload = normalizeChatPayload(text);
    if (!res.ok) {
      const failure = classifyUpstreamFailure(res.status, text, res.ok);
      const error = new Error(failure?.message || `HTTP ${res.status}: ${trimError(text)}`);
      error.statusCode = res.status;
      error.body = trimError(text);
      throw error;
    }
    return { payload, text };
  } finally {
    clearTimeout(timeout);
  }
}

function resultFromError(capability, err) {
  return {
    capability,
    status: "failed",
    detail: err.name === "AbortError" ? "请求超时" : (err.message || "请求失败"),
    evidence: err.body || ""
  };
}

function usageFromPayload(payload) {
  const usage = payload?.usage || {};
  return {
    promptTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    completionTokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0)
  };
}

function normalizeChatPayload(text) {
  const direct = parseJsonSafe(text);
  if (direct) return direct;

  const events = parseSseDataPayloads(text)
    .map((event) => parseJsonSafe(event))
    .filter(Boolean);
  if (!events.length) return null;

  const contentParts = [];
  const reasoningParts = [];
  const toolCallsByIndex = new Map();
  let finishReason = "";
  let usage = null;
  let id = "";
  let model = "";

  for (const event of events) {
    id ||= event.id || "";
    model ||= event.model || "";
    if (event.usage) usage = event.usage;
    const choice = event.choices?.[0];
    if (!choice) continue;
    finishReason ||= choice.finish_reason || choice.finishReason || "";

    const delta = choice.delta || {};
    appendContentPart(contentParts, delta.content);
    appendContentPart(reasoningParts, delta.reasoning_content || delta.reasoning);
    mergeToolCalls(toolCallsByIndex, delta.tool_calls || delta.function_call);

    const message = choice.message || {};
    appendContentPart(contentParts, message.content);
    appendContentPart(reasoningParts, message.reasoning_content || message.reasoning);
    mergeToolCalls(toolCallsByIndex, message.tool_calls || message.function_call);
  }

  return {
    id,
    object: "chat.completion",
    model,
    choices: [{
      index: 0,
      finish_reason: finishReason,
      message: {
        role: "assistant",
        content: contentParts.join(""),
        reasoning_content: reasoningParts.join(""),
        tool_calls: Array.from(toolCallsByIndex.values())
      }
    }],
    usage
  };
}

function appendContentPart(parts, value) {
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") parts.push(item);
      else if (typeof item?.text === "string") parts.push(item.text);
      else if (typeof item?.content === "string") parts.push(item.content);
    }
  }
}

function mergeToolCalls(target, value) {
  const calls = Array.isArray(value) ? value : value ? [value] : [];
  for (const call of calls) {
    const index = Number.isFinite(Number(call.index)) ? Number(call.index) : target.size;
    const existing = target.get(index) || {
      id: call.id || "",
      type: call.type || "function",
      function: { name: "", arguments: "" }
    };
    if (call.id) existing.id = call.id;
    if (call.type) existing.type = call.type;
    const fn = call.function || call;
    if (fn.name) existing.function.name += fn.name;
    if (fn.arguments) existing.function.arguments += fn.arguments;
    target.set(index, existing);
  }
}

function assistantText(payload) {
  const message = payload?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => typeof item === "string" ? item : item?.text || item?.content || "")
      .join("\n");
  }
  if (typeof payload?.output_text === "string") return payload.output_text;
  if (Array.isArray(payload?.output)) {
    return payload.output
      .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
      .map((item) => item?.text || item?.content || "")
      .join("\n");
  }
  return "";
}

function assistantToolCalls(payload) {
  const message = payload?.choices?.[0]?.message || {};
  return [
    ...(Array.isArray(message.tool_calls) ? message.tool_calls : []),
    ...(Array.isArray(payload?.tool_calls) ? payload.tool_calls : [])
  ];
}

async function testTextCompletion(target) {
  const startedAt = Date.now();
  try {
    const { payload, text } = await callTestChat(target, {
      temperature: 0,
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content: "1+1=?"
        }
      ]
    });
    const content = assistantText(payload).trim();
    const passed = content.length > 0;
    return {
      capability: "text",
      status: passed ? "passed" : "failed",
      latencyMs: Date.now() - startedAt,
      usage: usageFromPayload(payload),
      detail: passed ? "HTTP 200 且 choices[0].message.content 非空" : "HTTP 200 但没有返回非空文本内容",
      evidence: trimError(text)
    };
  } catch (err) {
    return resultFromError("text", err);
  }
}

async function testToolCalling(target) {
  const startedAt = Date.now();
  try {
    const { payload, text } = await callTestChat(target, {
      temperature: 0,
      max_tokens: 80,
      messages: [
        { role: "user", content: "调用天气工具查询东京的天气。" }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_current_weather",
            description: "查询指定城市的天气",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string", description: "城市名称" }
              },
              required: ["location"]
            }
          }
        }
      ],
      tool_choice: "auto"
    });
    const calls = assistantToolCalls(payload);
    const finishReason = payload?.choices?.[0]?.finish_reason || payload?.choices?.[0]?.finishReason || "";
    const matched = calls.some((call) => {
      const fn = call.function || call;
      const args = typeof fn.arguments === "string" ? parseJsonSafe(fn.arguments) : fn.arguments;
      return fn.name === "get_current_weather" && String(args?.location || "").includes("东京");
    });
    const toolFinish = finishReason === "tool_calls" || finishReason === "function_call";
    return {
      capability: "tool",
      status: matched && toolFinish ? "passed" : calls.length ? "uncertain" : "failed",
      latencyMs: Date.now() - startedAt,
      usage: usageFromPayload(payload),
      detail: matched && toolFinish
        ? "HTTP 200，finish_reason 为 tool_calls/function_call，且包含正确工具名和参数"
        : calls.length
          ? "返回了工具调用字段，但 finish_reason 或参数不完全符合预期"
          : "未返回 tool_calls/function_call，可能降级为普通文本或不支持 tools",
      evidence: trimError(text)
    };
  } catch (err) {
    return resultFromError("tool", err);
  }
}

function visionTestImageDataUrl() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#ffffff"/><text x="42" y="76" font-family="Arial" font-size="48" font-weight="700" fill="#111827">9527</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

async function testVision(target) {
  const startedAt = Date.now();
  try {
    const { payload, text } = await callTestChat(target, {
      temperature: 0,
      max_tokens: 80,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "图里的数字是多少？只回答数字。" },
            { type: "image_url", image_url: { url: visionTestImageDataUrl() } }
          ]
        }
      ]
    });
    const content = assistantText(payload).trim();
    const hasText = content.length > 0;
    const identified = content.includes("9527");
    const refusal = /cannot|can't|unable|image|vision|无法|不能|看不到|无法查看/.test(content.toLowerCase());
    return {
      capability: "vision",
      status: identified ? "passed" : hasText && !refusal ? "uncertain" : "failed",
      latencyMs: Date.now() - startedAt,
      usage: usageFromPayload(payload),
      detail: identified
        ? "HTTP 200，接口接受 image_url，并正确识别图片数字 9527"
        : hasText && !refusal
          ? "HTTP 200 且有文本回复，但未识别出 9527，可能静默忽略图片或视觉能力不稳定"
        : refusal
          ? "模型表示无法读取图片"
          : "HTTP 200 但没有返回可读文本",
      evidence: trimError(text)
    };
  } catch (err) {
    return resultFromError("vision", err);
  }
}

function configuredProviders(cfg) {
  const targets = [
    ...(cfg.models || []).flatMap((model) => model.targets || []),
    ...((cfg.modelSource && cfg.modelSource.targets) || [])
  ];
  const seen = new Set();
  return targets
    .filter((target) => target.baseUrl)
    .map((target) => ({
      id: `${target.name || ""}|${target.baseUrl || ""}|${target.apiKey || ""}`,
      name: target.name || target.baseUrl,
      baseUrl: target.baseUrl,
      apiKey: target.apiKey || ""
    }))
    .filter((provider) => {
      const key = `${provider.name}|${provider.baseUrl}|${provider.apiKey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function extractSourceModels(payload) {
  const sourceList = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];

  return sourceList
    .map((item) => {
      if (typeof item === "string") return { id: item };
      const id = item?.id || item?.name || item?.model || item?.publicName;
      return id ? { id: String(id) } : null;
    })
    .filter(Boolean);
}

function filterSourceModels(models, source) {
  const include = compilePattern(source.include);
  const exclude = compilePattern(source.exclude);
  return models.filter((item) => {
    if (include && !include.test(item.id)) return false;
    if (exclude && exclude.test(item.id)) return false;
    return true;
  });
}

function compilePattern(pattern) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function resolveTargetModelName(target, sourceModelName) {
  const template = target.modelNameTemplate || target.modelName || "{model}";
  return String(template).replaceAll("{model}", sourceModelName);
}

async function callTarget(req, pathname, body, model, target, cfg) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(target.timeoutMs || cfg.requestTimeoutMs));
  const nextBody = structuredClone(body);
  nextBody.model = target.modelName || body.model;
  const headers = {
    "content-type": "application/json",
    "authorization": `Bearer ${target.apiKey}`
  };

  if (req.headers["openai-organization"]) headers["openai-organization"] = req.headers["openai-organization"];
  if (req.headers["openai-project"]) headers["openai-project"] = req.headers["openai-project"];

  try {
    return await fetch(upstreamUrl(target, pathname), {
      method: "POST",
      headers,
      body: JSON.stringify(nextBody),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function handleModels(req, res, cfg) {
  if (!isProxyKey(req, cfg)) {
    sendError(res, 401, "Invalid proxy API key");
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const models = await runtimeModels(cfg);
  send(res, 200, {
    object: "list",
    data: models
      .map((model) => ({
        id: model.publicName,
        object: "model",
        created: now,
        owned_by: "failover-proxy"
      }))
  });
}

async function handleProxy(req, res, pathname, cfg) {
  if (!isProxyKey(req, cfg)) {
    sendError(res, 401, "Invalid proxy API key");
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    sendError(res, err.statusCode || 400, err.message || "Invalid JSON body");
    return;
  }

  const requestedModel = body.model;
  const model = await findModel(cfg, requestedModel);
  if (!model) {
    sendError(res, 404, `Model '${requestedModel}' is not configured`);
    return;
  }

  const targets = enabledTargets(model);
  if (!targets.length) {
    sendError(res, 503, `Model '${requestedModel}' has no enabled targets`);
    return;
  }

  stats.requests += 1;
  const chain = chainStats(model);
  chain.requests += 1;
  const startedAt = Date.now();
  const isStream = body.stream === true;
  const errors = [];
  const failedModels = [];
  let attempted = 0;

  for (const target of targets) {
    const maxAttempts = 1 + Math.max(0, Math.floor(Number(target.maxRetries) || 0));

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempted += 1;
      const targetStartedAt = Date.now();
      let upstream;
      try {
        upstream = await callTarget(req, pathname, body, model, target, cfg);
      } catch (err) {
        const failure = { message: err.name === "AbortError" ? "timeout" : err.message };
        recordTargetFailure(model, target, cfg, failure, Date.now() - targetStartedAt);
        errors.push({ target: target.name, attempt, message: failure.message });
        if (shouldRetryTarget(failure, cfg, attempt, maxAttempts)) continue;
        failedModels.push(targetLabel(target));
        break;
      }

      const responseType = upstream.headers.get("content-type") || (isStream ? "text/event-stream" : "application/json");
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        const failure = classifyUpstreamFailure(upstream.status, text, upstream.ok) || {
          status: upstream.status,
          message: `Upstream returned ${upstream.status}`,
          body: trimError(text)
        };
        recordTargetFailure(model, target, cfg, failure, Date.now() - targetStartedAt);
        errors.push({ target: target.name, attempt, status: failure.status || upstream.status, body: failure.body || failure.message });
        if (shouldRetryTarget(failure, cfg, attempt, maxAttempts)) continue;
        failedModels.push(targetLabel(target));
        if (shouldTryNext(failure.status || upstream.status, cfg)) break;
        stats.failures += 1;
        chain.failures += 1;
        addLog({
          chainName: model.publicName,
          originalModel: requestedModel,
          failedModels,
          finalModel: "",
          status: "failed",
          latency: Date.now() - startedAt,
          error: failure.message || `Upstream returned ${upstream.status}`
        });
        send(res, upstream.status, text || { error: { message: `Upstream returned ${upstream.status}` } }, { "content-type": responseType });
        return;
      }

      if (!isStream) {
        const text = await upstream.text().catch(() => "");
        const failure = classifyUpstreamFailure(upstream.status, text, upstream.ok);
        if (failure) {
          recordTargetFailure(model, target, cfg, failure, Date.now() - targetStartedAt);
          errors.push({ target: target.name, attempt, status: failure.status, body: failure.body || failure.message });
          if (shouldRetryTarget(failure, cfg, attempt, maxAttempts)) continue;
          failedModels.push(targetLabel(target));
          if (shouldTryNext(failure.status, cfg)) break;
          stats.failures += 1;
          chain.failures += 1;
          addLog({
            chainName: model.publicName,
            originalModel: requestedModel,
            failedModels,
            finalModel: "",
            status: "failed",
            latency: Date.now() - startedAt,
            error: failure.message
          });
          send(res, failure.status || 502, text || { error: { message: failure.message } }, { "content-type": responseType });
          return;
        }

        recordTarget(model, target, true, cfg, {}, Date.now() - targetStartedAt);
        stats.successes += 1;
        chain.successes += 1;
        if (failedModels.length > 0) {
          stats.failovers += 1;
          chain.failovers += 1;
        }
        addLog({
          chainName: model.publicName,
          originalModel: requestedModel,
          failedModels,
          finalModel: targetLabel(target),
          status: "success",
          latency: Date.now() - startedAt,
          error: errors.length ? errors.map(formatAttemptError).join(", ") : ""
        });

        res.writeHead(upstream.status, withCors({
          "content-type": responseType,
          "cache-control": "no-cache",
          "x-proxy-target": target.name || "",
          "x-proxy-model": target.modelName || ""
        }));
        res.end(text);
        return;
      }

      let inspected;
      try {
        inspected = await inspectInitialStream(upstream);
      } catch (err) {
        const failure = { message: err.name === "AbortError" ? "timeout" : err.message };
        recordTargetFailure(model, target, cfg, failure, Date.now() - targetStartedAt);
        errors.push({ target: target.name, attempt, message: failure.message });
        if (shouldRetryTarget(failure, cfg, attempt, maxAttempts)) continue;
        failedModels.push(targetLabel(target));
        break;
      }

      if (inspected.failure) {
        await inspected.reader?.cancel().catch(() => undefined);
        const failure = inspected.failure;
        recordTargetFailure(model, target, cfg, failure, Date.now() - targetStartedAt);
        errors.push({ target: target.name, attempt, status: failure.status, body: failure.body || failure.message });
        if (shouldRetryTarget(failure, cfg, attempt, maxAttempts)) continue;
        failedModels.push(targetLabel(target));
        if (shouldTryNext(failure.status, cfg)) break;
        stats.failures += 1;
        chain.failures += 1;
        addLog({
          chainName: model.publicName,
          originalModel: requestedModel,
          failedModels,
          finalModel: "",
          status: "failed",
          latency: Date.now() - startedAt,
          error: failure.message
        });
        send(res, failure.status || 502, { error: { message: failure.message } });
        return;
      }

      const headers = withCors({
        "content-type": responseType,
        "cache-control": isStream ? "no-cache, no-transform" : "no-cache",
        "x-proxy-target": target.name || "",
        "x-proxy-model": target.modelName || ""
      });

      res.writeHead(upstream.status, headers);

      if (!inspected.reader) {
        res.end();
        recordTarget(model, target, true, cfg, {}, Date.now() - targetStartedAt);
        stats.successes += 1;
        chain.successes += 1;
        if (failedModels.length > 0) {
          stats.failovers += 1;
          chain.failovers += 1;
        }
        addLog({
          chainName: model.publicName,
          originalModel: requestedModel,
          failedModels,
          finalModel: targetLabel(target),
          status: "success",
          latency: Date.now() - startedAt,
          error: errors.length ? errors.map(formatAttemptError).join(", ") : ""
        });
        return;
      }

      try {
        const reader = inspected.reader;
        const streamDecoder = new TextDecoder();
        let streamText = "";
        let streamFailure = null;
        const detectStreamFailure = (chunk) => {
          if (streamFailure) return;
          streamText += streamDecoder.decode(chunk, { stream: true });
          streamFailure = classifyUpstreamFailure(upstream.status, streamText, upstream.ok);
        };

        for (const chunk of inspected.chunks) {
          detectStreamFailure(chunk);
          res.write(Buffer.from(chunk));
        }
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          detectStreamFailure(value);
          res.write(Buffer.from(value));
        }
        streamText += streamDecoder.decode();
        res.end();
        if (streamFailure) {
          recordTargetFailure(model, target, cfg, streamFailure, Date.now() - targetStartedAt);
          stats.failures += 1;
          chain.failures += 1;
          const streamFailedModels = [...failedModels, targetLabel(target)];
          addLog({
            chainName: model.publicName,
            originalModel: requestedModel,
            failedModels: streamFailedModels,
            finalModel: "",
            status: "failed",
            latency: Date.now() - startedAt,
            error: streamFailure.message
          });
          return;
        }

        recordTarget(model, target, true, cfg, {}, Date.now() - targetStartedAt);
        stats.successes += 1;
        chain.successes += 1;
        if (failedModels.length > 0) {
          stats.failovers += 1;
          chain.failovers += 1;
        }
        addLog({
          chainName: model.publicName,
          originalModel: requestedModel,
          failedModels,
          finalModel: targetLabel(target),
          status: "success",
          latency: Date.now() - startedAt,
          error: errors.length ? errors.map(formatAttemptError).join(", ") : ""
        });
      } catch (err) {
        res.destroy(err);
      }
      return;
    }
  }

  stats.failures += 1;
  chain.failures += 1;
  addLog({
    chainName: model.publicName,
    originalModel: requestedModel,
    failedModels,
    finalModel: "",
    status: "failed",
    latency: Date.now() - startedAt,
    error: errors.map(formatAttemptError).join(", ")
  });
  sendError(res, 503, "All configured targets failed before a response could be returned", errors);
}

function targetLabel(target) {
  return target.modelName || target.name || target.baseUrl;
}

function formatAttemptError(item) {
  const suffix = item.attempt ? `#${item.attempt}` : "";
  return `${item.target || "target"}${suffix}: ${item.status || item.message}`;
}

function shouldRetryTarget(failure, cfg, attempt, maxAttempts) {
  if (attempt >= maxAttempts) return false;
  const status = Number(failure?.status || 0);
  const immediateCooldownStatusCodes = cfg?.circuitBreaker?.immediateCooldownStatusCodes || defaultConfig.circuitBreaker.immediateCooldownStatusCodes;
  if (immediateCooldownStatusCodes.includes(status)) return false;
  if (!status) return true;
  return status >= 500 || status === 408 || status === 409;
}

function trimError(text) {
  return String(text || "").slice(0, 1500);
}

async function handleAdminApi(req, res, pathname, cfg) {
  if (!isAdmin(req, cfg)) {
    sendError(res, 401, "Invalid admin token");
    return;
  }

  if (req.method === "GET" && pathname === "/api/config") {
    send(res, 200, cfg);
    return;
  }

  if (req.method === "POST" && pathname === "/api/config") {
    try {
      const nextConfig = await readJson(req);
      await saveConfig(nextConfig);
      send(res, 200, { ok: true, config: configCache });
    } catch (err) {
      sendError(res, 400, err.message || "Invalid config JSON");
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/stats") {
    send(res, 200, stats);
    return;
  }

  if (req.method === "POST" && pathname === "/api/providers/health") {
    try {
      const body = await readJson(req);
      const providers = Array.isArray(body.providers) ? body.providers : configuredProviders(cfg);
      const results = await Promise.all(providers.map((provider) => checkProviderHealth(provider)));
      send(res, 200, { ok: true, providers: results });
    } catch (err) {
      sendError(res, 400, err.message || "Cannot check provider health");
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/model-tests/run") {
    await handleModelTests(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/model-source/preview") {
    try {
      const body = await readJson(req);
      const source = normalizeModelSource({ ...cfg.modelSource, ...body, enabled: true });
      const models = filterSourceModels(await fetchModelSource(source), source);
      send(res, 200, {
        ok: true,
        count: models.length,
        models: models.slice(0, 200).map((item) => item.id)
      });
    } catch (err) {
      sendError(res, 400, err.message || "Cannot preview model source");
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/model-source/refresh") {
    try {
      const models = await sourceRuntimeModels(cfg, true);
      send(res, 200, {
        ok: true,
        count: models.length,
        models: models.slice(0, 200).map((model) => model.publicName)
      });
    } catch (err) {
      sendError(res, 400, err.message || "Cannot refresh model source");
    }
    return;
  }

  sendError(res, 404, "Admin API route not found");
}

async function serveStatic(req, res, pathname) {
  const resolved = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(resolved).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    sendError(res, 403, "Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    const type = staticTypes[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, withCors({ "content-type": type, "cache-control": "no-cache" }));
    res.end(content);
  } catch {
    if (!pathname.startsWith("/api/") && !pathname.startsWith("/v1/")) {
      const content = await readFile(path.join(publicDir, "index.html"));
      res.writeHead(200, withCors({ "content-type": staticTypes[".html"], "cache-control": "no-cache" }));
      res.end(content);
      return;
    }
    sendError(res, 404, "Not found");
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204, withCors());
    res.end();
    return;
  }

  let cfg;
  try {
    cfg = await loadConfig();
  } catch (err) {
    sendError(res, 500, `Cannot load config: ${err.message}`);
    return;
  }

  if (req.method === "GET" && pathname === "/api/health") {
    const models = await runtimeModels(cfg);
    send(res, 200, {
      ok: true,
      startedAt: stats.startedAt,
      configPath,
      models: models.map((model) => model.publicName),
      modelSourceError: modelSourceCache.error || ""
    });
    return;
  }

  if (pathname === "/v1/models" || pathname === "/models") {
    await handleModels(req, res, cfg);
    return;
  }

  if (req.method === "POST" && isCompletionEndpoint(pathname)) {
    await handleProxy(req, res, pathname, cfg);
    return;
  }

  if (pathname.startsWith("/api/")) {
    await handleAdminApi(req, res, pathname, cfg);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(req, res, pathname);
    return;
  }

  send(res, 405, "Method not allowed", textType);
}

await ensureConfig();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    sendError(res, 500, err.message || "Internal server error");
  });
});

server.listen(port, host, () => {
  console.log(`OpenAI failover proxy listening on http://${host}:${port}`);
  console.log(`Admin UI: http://127.0.0.1:${port}`);
  console.log(`Config: ${configPath}`);
});
