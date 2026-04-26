const { runSimulation } = require("../public/simulation.js");

const COMPONENT_PROFILES = {
  edge: { group: "control", assumption: "Fast edge hop before policy evaluation." },
  client: { group: "control", assumption: "Traffic source and network edge behavior are folded into arrival rate and control-plane latency." },
  internet: { group: "control", assumption: "Internet transit is approximated as control-plane latency before limiter decision." },
  waf: { group: "control", assumption: "WAF contributes fast decision latency and may attach limiter rules." },
  load_balancer: { group: "control", assumption: "Load balancer is modeled as low-latency control-plane processing." },
  webserver: { group: "webserver", assumption: "Webserver is modeled as the high-capacity front door that owns active requests and the end-to-end timeout." },
  web_server: { group: "webserver", assumption: "Webserver is modeled as the high-capacity front door that owns active requests and the end-to-end timeout." },
  nginx: { group: "webserver", assumption: "Nginx is modeled as the high-capacity front door that owns active requests and the end-to-end timeout." },
  api_gateway: { group: "control", assumption: "API gateway is modeled as fast pre-admission logic and may attach limiter rules." },
  app: { group: "app", assumption: "App service owns active capacity, pending capacity, and app timeout." },
  app_service: { group: "app", assumption: "App service owns active capacity, pending capacity, and app timeout." },
  service: { group: "app", assumption: "Service node is folded into the app execution stage." },
  cache: { group: "dependency", assumption: "Downstream cache is folded into dependency capacity and dependency latency." },
  db: { group: "dependency", assumption: "Database is folded into dependency capacity, timeout, and downstream latency." },
  queue: { group: "dependency", assumption: "Async queue or broker is approximated as downstream pending capacity and latency." },
  worker: { group: "dependency", assumption: "Worker pool is approximated as downstream capacity." },
  third_party_api: { group: "dependency", assumption: "External API is folded into dependency latency and timeout." },
  dependency: { group: "dependency", assumption: "Generic downstream dependency is folded into dependency latency and capacity." }
};

const STAGE_KEYS = {
  app: {
    label: "app-stage",
    latency: "latA", jitter: "latB", dist: "latencyDist",
    maxConcurrent: "maxConcurrent", queueCapacity: "queueCapacity", timeout: "maxQueueWaitMs"
  },
  dependency: {
    label: "dependency-stage",
    latency: "depLatA", jitter: "depLatB", dist: "depLatencyDist",
    maxConcurrent: "depMaxConcurrent"
  }
};

const round = (v) => Math.round(v * 100) / 100;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const defined = (xs) => xs.filter((v) => v != null);

function defaultSimulationConfig() {
  return {
    durationSec: 15, stepMs: 100, rps: 90, burstiness: 0.4,
    wsMaxConcurrent: 1000, wsQueueCapacity: 5000, wsMaxQueueWaitMs: 1000, wsRequestTimeoutMs: 5000,
    maxConcurrent: 24, queueCapacity: 3000, maxQueueWaitMs: 1500,
    limiterType: "sliding", windows: [{ windowMs: 1000, limit: 30 }],
    rlFailureMode: "fail_closed",
    rlLatencyDist: "constant", rlLatA: 8, rlLatB: 4,
    rlMaxConcurrent: 1000, rlQueueCapacity: 5000, rlMaxQueueWaitMs: 1000,
    latencyDist: "normal", latA: 800, latB: 35,
    depMaxConcurrent: 12,
    depLatencyDist: "normal", depLatA: 180, depLatB: 60
  };
}

function summarizeResult(result) {
  return {
    arrived: result.totals.arrived,
    enteredWebserver: result.totals.enteredWebserver,
    enteredLimiter: result.totals.enteredLimiter,
    enteredApp: result.totals.enteredApp,
    enteredDependency: result.totals.enteredDependency,
    served: result.totals.served,
    rate429: result.totals.rate429,
    rate503: result.totals.rate503,
    wsDroppedFull: result.totals.wsDroppedFull,
    wsDroppedWait: result.totals.wsDroppedWait,
    wsDroppedTimeout: result.totals.wsDroppedTimeout,
    limiterDroppedFull: result.totals.limiterDroppedFull,
    limiterDroppedWait: result.totals.limiterDroppedWait,
    limiterBypassed: result.totals.limiterBypassed,
    appDroppedFull: result.totals.appDroppedFull,
    appDroppedWait: result.totals.appDroppedWait,
    depDroppedFull: result.totals.depDroppedFull,
    depDroppedWait: result.totals.depDroppedWait,
    servedPct: round(result.totals.servedPct),
    rate429Pct: round(result.totals.rate429Pct),
    rate503Pct: round(result.totals.rate503Pct),
    p50: round(result.latency.p50),
    p95: round(result.latency.p95),
    p99: round(result.latency.p99),
    avgLatency: round(result.latency.avg),
    peakWsQueue: result.queues.peakWsQueue,
    peakWsActive: result.queues.peakWsActive,
    peakLimiterPending: result.queues.peakLimiterPending,
    peakLimiterQueue: result.queues.peakLimiterQueue,
    peakLimiterInflight: result.queues.peakLimiterInflight,
    peakAppQueue: result.queues.peakAppQueue,
    peakDepInflight: result.queues.peakDepInflight
  };
}

function mergeConfig(base, overrides = {}) {
  const next = { ...base, ...overrides };
  if (Array.isArray(overrides.windows)) next.windows = overrides.windows.map((w) => ({ ...w }));
  return next;
}

function reviewRateLimitConfig(config) {
  const warnings = [];
  const wins = config.windows || [];
  if (!wins.length) {
    warnings.push("No limiter rules configured. The model will never emit 429, only downstream 503 under saturation.");
  } else {
    const minLimit = Math.min(...wins.map((w) => w.limit));
    if (minLimit <= 0) warnings.push("Limiter contains a zero-or-negative limit, which will reject nearly all traffic.");
    if (config.depMaxConcurrent && minLimit > config.depMaxConcurrent * 20) {
      warnings.push("Limiter looks looser than downstream capacity. Expect 503 to dominate instead of 429.");
    }
  }
  if (config.maxQueueWaitMs > config.latA * 5) {
    warnings.push("App pending timeout is much larger than app latency. This may hide overload behind very long waits.");
  }
  if (config.rlMaxQueueWaitMs < config.rlLatA / 2) {
    const outcome = config.rlFailureMode === "bypass" ? "bypass to app" : "503 from limiter queue timeouts";
    warnings.push(`Limiter pending timeout is shorter than typical decision latency. Expect ${outcome}.`);
  }
  if (config.wsRequestTimeoutMs < config.rlLatA + config.latA + config.depLatA) {
    warnings.push("Webserver end-to-end timeout is shorter than typical limiter+app+dependency time. Expect webserver-owned 503 timeouts.");
  }
  return warnings;
}

// Collapse N components in a group into the flat simulator's single stage.
// Latency sums, jitter combines in quadrature, capacity/queue/timeout take
// the tightest bound — each of those is a lossy model simplification.
function collapseStage(components, config, keys, warnings) {
  if (!components.length) return [];
  const names = components.map((c) => c.name || c.kind);
  const latencies = defined(components.map((c) => c.latencyMs));
  const jitters = defined(components.map((c) => c.jitterMs));
  const dists = components.map((c) => c.latencyDist).filter(Boolean);
  const maxConc = defined(components.map((c) => c.maxConcurrent));
  const caps = keys.queueCapacity ? defined(components.map((c) => c.queueCapacity)) : [];
  const timeouts = keys.timeout ? defined(components.map((c) => c.timeoutMs)) : [];

  if (latencies.length) config[keys.latency] = sum(latencies);
  if (jitters.length) config[keys.jitter] = round(Math.sqrt(sum(jitters.map((j) => j * j))));
  if (dists.length) {
    config[keys.dist] = dists[0];
    if (dists.some((d) => d !== dists[0])) {
      warnings.push(
        `Multiple ${keys.label} latency distributions were provided (${[...new Set(dists)].join(", ")}). Using ${dists[0]} for the collapsed stage.`
      );
    }
  }
  if (maxConc.length) config[keys.maxConcurrent] = Math.min(...maxConc);
  if (caps.length) config[keys.queueCapacity] = Math.min(...caps);
  if (timeouts.length) config[keys.timeout] = Math.min(...timeouts);
  if (components.length > 1) {
    const capacityCopy = keys.queueCapacity && keys.timeout
      ? "concurrency/queue/timeout were reduced to the tightest bound"
      : "concurrency was reduced to the tightest bound";
    warnings.push(
      `Multiple ${keys.label} components were collapsed into one simulator stage. Latency was summed, jitter combined, and ${capacityCopy}.`
    );
  }
  return names;
}

function normalizeComponentPath(input = {}) {
  const warnings = [];
  const assumptions = [];
  const config = mergeConfig(defaultSimulationConfig(), input.defaults || {});
  if (input.traffic) Object.assign(config, input.traffic);

  const grouped = { webserver: [], control: [], app: [], dependency: [] };
  const windows = [];
  for (const component of input.components || []) {
    const kind = String(component.kind || "").toLowerCase();
    const profile = COMPONENT_PROFILES[kind];
    if (!profile) {
      warnings.push(`Unsupported component kind: ${kind || "unknown"}. It was ignored.`);
      continue;
    }
    assumptions.push({ component: component.name || kind, kind, assumption: profile.assumption });
    grouped[profile.group].push(component);
    if (profile.group === "control" && Array.isArray(component.rateLimiter?.windows)) {
      if (component.rateLimiter.type) config.limiterType = component.rateLimiter.type;
      for (const w of component.rateLimiter.windows) {
        windows.push({ windowMs: w.windowMs, limit: w.limit });
      }
    }
  }

  const controlLatency = sum(grouped.control.map((c) => c.latencyMs ?? 0));
  const controlJitterVar = sum(grouped.control.map((c) => (c.jitterMs ?? 0) ** 2));
  const controlMaxConc = defined(grouped.control.map((c) => c.maxConcurrent));
  const controlCaps = defined(grouped.control.map((c) => c.queueCapacity));
  const controlTimeouts = defined(grouped.control.map((c) => c.timeoutMs));
  config.rlLatA = Math.max(1, controlLatency || config.rlLatA);
  config.rlLatB = Math.max(0, Math.sqrt(controlJitterVar) || config.rlLatB);
  if (controlMaxConc.length) config.rlMaxConcurrent = Math.min(...controlMaxConc);
  if (controlCaps.length) config.rlQueueCapacity = Math.min(...controlCaps);
  if (controlTimeouts.length) config.rlMaxQueueWaitMs = Math.min(...controlTimeouts);

  const webMaxConc = defined(grouped.webserver.map((c) => c.maxConcurrent));
  const webCaps = defined(grouped.webserver.map((c) => c.queueCapacity));
  const webQueueTimeouts = defined(grouped.webserver.map((c) => c.queueTimeoutMs));
  const webRequestTimeouts = defined(grouped.webserver.map((c) => c.requestTimeoutMs ?? c.timeoutMs));
  if (webMaxConc.length) config.wsMaxConcurrent = Math.min(...webMaxConc);
  if (webCaps.length) config.wsQueueCapacity = Math.min(...webCaps);
  if (webQueueTimeouts.length) config.wsMaxQueueWaitMs = Math.min(...webQueueTimeouts);
  if (webRequestTimeouts.length) config.wsRequestTimeoutMs = Math.min(...webRequestTimeouts);

  const appNames = collapseStage(grouped.app, config, STAGE_KEYS.app, warnings);
  const depNames = collapseStage(grouped.dependency, config, STAGE_KEYS.dependency, warnings);

  if (windows.length) config.windows = windows;
  if (!grouped.app.length) warnings.push("No explicit app component provided. Default app capacity assumptions were used.");
  if (!grouped.dependency.length) warnings.push("No explicit dependency component provided. Default downstream assumptions were used.");
  warnings.push(...reviewRateLimitConfig(config));

  return {
    config,
    assumptions,
    warnings,
    collapse: {
      webserver: {
        componentCount: grouped.webserver.length,
        maxConcurrent: config.wsMaxConcurrent,
        queueCapacity: config.wsQueueCapacity,
        queueTimeoutMs: config.wsMaxQueueWaitMs,
        requestTimeoutMs: config.wsRequestTimeoutMs
      },
      control: {
        componentCount: grouped.control.length,
        latencyMs: round(config.rlLatA),
        jitterMs: round(config.rlLatB),
        maxConcurrent: config.rlMaxConcurrent,
        queueCapacity: config.rlQueueCapacity,
        timeoutMs: config.rlMaxQueueWaitMs,
        windows: config.windows
      },
      app: {
        components: appNames,
        latencyMs: round(config.latA), jitterMs: round(config.latB), latencyDist: config.latencyDist,
        maxConcurrent: config.maxConcurrent, queueCapacity: config.queueCapacity, timeoutMs: config.maxQueueWaitMs
      },
      dependency: {
        components: depNames,
        latencyMs: round(config.depLatA), jitterMs: round(config.depLatB), latencyDist: config.depLatencyDist,
        maxConcurrent: config.depMaxConcurrent
      }
    }
  };
}

function simulateScenario(input = {}) {
  const config = mergeConfig(defaultSimulationConfig(), input.config || input);
  const result = runSimulation(config);
  return { config, summary: summarizeResult(result), warnings: reviewRateLimitConfig(config), result };
}

function compareScenarios(input = {}) {
  const base = simulateScenario({ config: input.base });
  const candidate = simulateScenario({ config: input.candidate });
  const deltaKeys = [
    "served", "rate429", "rate503", "enteredWebserver", "enteredLimiter", "enteredApp", "enteredDependency",
    "peakWsQueue", "peakWsActive", "peakAppQueue", "peakDepInflight",
    "wsDroppedFull", "wsDroppedWait", "wsDroppedTimeout",
    "limiterDroppedFull", "limiterDroppedWait", "limiterBypassed",
    "appDroppedFull", "appDroppedWait", "depDroppedFull"
  ];
  const delta = Object.fromEntries(deltaKeys.map((k) => [k, candidate.summary[k] - base.summary[k]]));
  delta.p95 = round(candidate.summary.p95 - base.summary.p95);
  // Paired no-limiter runs let us attribute load reduction honestly,
  // rather than equating every 429 with an avoided backend hit.
  // Positive delta = candidate limiter protects backend more than base.
  const openBase = runSimulation(mergeConfig(defaultSimulationConfig(), { ...(input.base || {}), windows: [] }));
  const openCand = runSimulation(mergeConfig(defaultSimulationConfig(), { ...(input.candidate || {}), windows: [] }));
  const baseAppAvoided = openBase.totals.enteredApp - base.summary.enteredApp;
  const candAppAvoided = openCand.totals.enteredApp - candidate.summary.enteredApp;
  const baseDepAvoided = openBase.totals.enteredDependency - base.summary.enteredDependency;
  const candDepAvoided = openCand.totals.enteredDependency - candidate.summary.enteredDependency;
  delta.appLoadAvoidedVsNoLimiter = candAppAvoided - baseAppAvoided;
  delta.depLoadAvoidedVsNoLimiter = candDepAvoided - baseDepAvoided;
  return {
    base: base.summary,
    candidate: candidate.summary,
    delta,
    warnings: [...new Set([...base.warnings, ...candidate.warnings])]
  };
}

function reviewComponentPath(input = {}) {
  const normalized = normalizeComponentPath(input);
  const result = runSimulation(normalized.config);
  return {
    normalizedConfig: normalized.config,
    collapse: normalized.collapse,
    assumptions: normalized.assumptions,
    warnings: normalized.warnings,
    summary: summarizeResult(result),
    result
  };
}

module.exports = {
  COMPONENT_PROFILES,
  defaultSimulationConfig,
  normalizeComponentPath,
  reviewRateLimitConfig,
  simulateScenario,
  compareScenarios,
  reviewComponentPath
};
