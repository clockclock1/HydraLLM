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
    cooldownMinutes: 10
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
  cfg.models = Array.isArray(cfg.models) ? cfg.models : [];
  cfg.modelSource = normalizeModelSource(cfg.modelSource);
  return cfg;
}

function normalizeCircuitBreaker(input) {
  const breaker = { ...defaultConfig.circuitBreaker, ...(input || {}) };
  breaker.failureThreshold = Math.max(1, Number(breaker.failureThreshold || defaultConfig.circuitBreaker.failureThreshold));
  breaker.cooldownMinutes = Math.max(1, Number(breaker.cooldownMinutes || defaultConfig.circuitBreaker.cooldownMinutes));
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
  source.targets = Array.isArray(source.targets) ? source.targets : [];
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
  const configured = (model.targets || []).filter((target) => target.enabled !== false && target.baseUrl && target.apiKey);
  const available = configured.filter((target) => !isCircuitOpen(model, target));
  if (!configured.length || available.length) return available;

  resetModelCircuits(model);
  return configured;
}

function targetKey(model, target) {
  return `${model.publicName}/${target.name || ""}/${target.modelName || ""}/${target.baseUrl || ""}`;
}

function recordTarget(model, target, ok, cfg) {
  const key = targetKey(model, target);
  const failureThreshold = cfg?.circuitBreaker?.failureThreshold || defaultConfig.circuitBreaker.failureThreshold;
  const cooldownMs = (cfg?.circuitBreaker?.cooldownMinutes || defaultConfig.circuitBreaker.cooldownMinutes) * 60 * 1000;
  stats.targets[key] ||= {
    model: model.publicName,
    target: target.name || target.modelName || target.baseUrl,
    upstreamModel: target.modelName || "",
    baseUrl: target.baseUrl || "",
    ok: 0,
    error: 0,
    consecutiveFailures: 0,
    disabledUntil: 0
  };
  if (ok) {
    stats.targets[key].ok += 1;
    stats.targets[key].consecutiveFailures = 0;
    circuitBreakers.delete(key);
  } else {
    stats.targets[key].error += 1;
    const breaker = circuitBreakers.get(key) || { failures: 0, disabledUntil: 0 };
    breaker.failures += 1;
    if (breaker.failures >= failureThreshold) {
      breaker.disabledUntil = Date.now() + cooldownMs;
    }
    circuitBreakers.set(key, breaker);
    stats.targets[key].consecutiveFailures = breaker.failures;
    stats.targets[key].disabledUntil = breaker.disabledUntil || 0;
  }
}

function upstreamUrl(target, pathname) {
  const base = target.baseUrl.replace(/\/+$/, "");
  return `${base}/${endpointSuffix(pathname)}`;
}

function shouldTryNext(statusCode, cfg) {
  return cfg.failoverStatusCodes.includes(Number(statusCode));
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
    attempted += 1;
    let upstream;
    try {
      upstream = await callTarget(req, pathname, body, model, target, cfg);
    } catch (err) {
      recordTarget(model, target, false, cfg);
      errors.push({ target: target.name, message: err.name === "AbortError" ? "timeout" : err.message });
      failedModels.push(target.modelName || target.name || target.baseUrl);
      continue;
    }

    const responseType = upstream.headers.get("content-type") || (isStream ? "text/event-stream" : "application/json");
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      recordTarget(model, target, false, cfg);
      errors.push({ target: target.name, status: upstream.status, body: trimError(text) });
      failedModels.push(target.modelName || target.name || target.baseUrl);
      if (shouldTryNext(upstream.status, cfg)) continue;
      stats.failures += 1;
      chain.failures += 1;
      addLog({
        chainName: model.publicName,
        originalModel: requestedModel,
        failedModels,
        finalModel: "",
        status: "failed",
        latency: Date.now() - startedAt,
        error: `Upstream returned ${upstream.status}`
      });
      send(res, upstream.status, text || { error: { message: `Upstream returned ${upstream.status}` } }, { "content-type": responseType });
      return;
    }

    recordTarget(model, target, true, cfg);
    stats.successes += 1;
    chain.successes += 1;
    if (attempted > 1) {
      stats.failovers += 1;
      chain.failovers += 1;
    }
    addLog({
      chainName: model.publicName,
      originalModel: requestedModel,
      failedModels,
      finalModel: target.modelName || target.name || target.baseUrl,
      status: "success",
      latency: Date.now() - startedAt,
      error: errors.length ? errors.map((item) => `${item.target || "target"}: ${item.status || item.message}`).join(", ") : ""
    });

    const headers = withCors({
      "content-type": responseType,
      "cache-control": isStream ? "no-cache, no-transform" : "no-cache",
      "x-proxy-target": target.name || "",
      "x-proxy-model": target.modelName || ""
    });

    res.writeHead(upstream.status, headers);

    if (!upstream.body) {
      res.end();
      return;
    }

    try {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) {
      res.destroy(err);
    }
    return;
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
    error: errors.map((item) => `${item.target || "target"}: ${item.status || item.message}`).join(", ")
  });
  sendError(res, 503, "All configured targets failed before a response could be returned", errors);
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
