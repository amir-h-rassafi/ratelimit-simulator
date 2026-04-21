const { runSimulation } = require("../simulation.js");

const COMPONENT_PROFILES = {
  edge: { group: "control", assumption: "Fast edge hop before policy evaluation." },
  client: { group: "control", assumption: "Traffic source and network edge behavior are folded into arrival rate and control-plane latency." },
  internet: { group: "control", assumption: "Internet transit is approximated as control-plane latency before limiter decision." },
  waf: { group: "control", assumption: "WAF contributes fast decision latency and may attach limiter rules." },
  load_balancer: { group: "control", assumption: "Load balancer is modeled as low-latency control-plane processing." },
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

function defaultSimulationConfig() {
  return {
    durationSec: 15,
    stepMs: 100,
    rps: 90,
    burstiness: 0.4,
    maxConcurrent: 24,
    queueCapacity: 3000,
    maxQueueWaitMs: 1500,
    limiterType: "sliding",
    windows: [{ windowMs: 1000, limit: 30 }],
    rlLatencyDist: "constant",
    rlLatA: 8,
    rlLatB: 4,
    latencyDist: "normal",
    latA: 800,
    latB: 35,
    depMaxConcurrent: 12,
    depQueueCapacity: 600,
    depMaxQueueWaitMs: 1000,
    depLatencyDist: "normal",
    depLatA: 180,
    depLatB: 60
  };
}

function summarizeResult(result) {
  return {
    arrived: result.totals.arrived,
    enteredApp: result.totals.enteredApp,
    enteredDependency: result.totals.enteredDependency,
    served: result.totals.served,
    rate429: result.totals.rate429,
    rate503: result.totals.rate503,
    servedPct: round(result.totals.servedPct),
    rate429Pct: round(result.totals.rate429Pct),
    rate503Pct: round(result.totals.rate503Pct),
    p50: round(result.latency.p50),
    p95: round(result.latency.p95),
    p99: round(result.latency.p99),
    avgLatency: round(result.latency.avg),
    peakLimiterPending: result.queues.peakLimiterPending,
    peakAppQueue: result.queues.peakAppQueue,
    peakDepQueue: result.queues.peakDepQueue,
    protectionPct: round(result.protection.protectionPct),
    appLoadAvoided: result.protection.appLoadAvoided,
    dependencyLoadAvoided: result.protection.dependencyLoadAvoided
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function mergeConfig(base, overrides = {}) {
  const next = { ...base, ...overrides };
  if (Array.isArray(overrides.windows)) next.windows = overrides.windows.map((item) => ({ ...item }));
  return next;
}

function reviewRateLimitConfig(config) {
  const warnings = [];
  if (!config.windows || config.windows.length === 0) {
    warnings.push("No limiter rules configured. The model will never emit 429, only downstream 503 under saturation.");
  }
  if (config.windows && config.windows.length > 0) {
    const minWindowLimit = Math.min(...config.windows.map((w) => w.limit));
    if (minWindowLimit <= 0) warnings.push("Limiter contains a zero-or-negative limit, which will reject nearly all traffic.");
    if (config.depMaxConcurrent && minWindowLimit > config.depMaxConcurrent * 20) {
      warnings.push("Limiter looks looser than downstream capacity. Expect 503 to dominate instead of 429.");
    }
  }
  if (config.maxQueueWaitMs > config.latA * 5) {
    warnings.push("App pending timeout is much larger than app latency. This may hide overload behind very long waits.");
  }
  if (config.depMaxQueueWaitMs < config.depLatA / 2) {
    warnings.push("Dependency timeout is shorter than typical downstream latency. Expect 503 from premature downstream timeout.");
  }
  return warnings;
}

function makeStageAccumulator(defaults, fallbackDistKey) {
  return {
    components: [],
    latencyMs: 0,
    jitterVar: 0,
    hasLatency: false,
    hasJitter: false,
    latencyDist: defaults[fallbackDistKey],
    hasDist: false,
    maxConcurrent: [],
    queueCapacity: [],
    timeoutMs: []
  };
}

function ingestStageComponent(stage, component, warnings, groupLabel) {
  stage.components.push(component.name || component.kind);
  if (component.latencyMs != null) {
    stage.latencyMs += component.latencyMs;
    stage.hasLatency = true;
  }
  if (component.jitterMs != null) {
    stage.jitterVar += component.jitterMs * component.jitterMs;
    stage.hasJitter = true;
  }
  if (component.latencyDist) {
    if (stage.hasDist && stage.latencyDist !== component.latencyDist) {
      warnings.push(
        `Multiple ${groupLabel} latency distributions were provided (${stage.latencyDist}, ${component.latencyDist}). Using ${stage.latencyDist} for the collapsed stage.`
      );
    } else {
      stage.latencyDist = component.latencyDist;
      stage.hasDist = true;
    }
  }
  if (component.maxConcurrent != null) stage.maxConcurrent.push(component.maxConcurrent);
  if (component.queueCapacity != null) stage.queueCapacity.push(component.queueCapacity);
  if (component.timeoutMs != null) stage.timeoutMs.push(component.timeoutMs);
}

function applyStageAccumulator(config, stage, keys, warnings, groupLabel) {
  if (!stage.components.length) return;
  if (stage.hasLatency) config[keys.latency] = stage.latencyMs;
  if (stage.hasJitter) config[keys.jitter] = round(Math.sqrt(stage.jitterVar));
  config[keys.dist] = stage.latencyDist;
  if (stage.maxConcurrent.length) config[keys.maxConcurrent] = Math.min(...stage.maxConcurrent);
  if (stage.queueCapacity.length) config[keys.queueCapacity] = Math.min(...stage.queueCapacity);
  if (stage.timeoutMs.length) config[keys.timeout] = Math.min(...stage.timeoutMs);
  if (stage.components.length > 1) {
    warnings.push(
      `Multiple ${groupLabel} components were collapsed into one simulator stage. Latency was summed, jitter combined, and concurrency/queue/timeout were reduced to the tightest bound.`
    );
  }
}

function normalizeComponentPath(input = {}) {
  const warnings = [];
  const assumptions = [];
  const config = mergeConfig(defaultSimulationConfig(), input.defaults || {});
  const components = Array.isArray(input.components) ? input.components : [];

  if (input.traffic) {
    Object.assign(config, input.traffic);
  }

  const windows = [];
  let controlLatency = 0;
  let controlLatencyVar = 0;
  let appSeen = false;
  let depSeen = false;
  const appStage = makeStageAccumulator(config, "latencyDist");
  const depStage = makeStageAccumulator(config, "depLatencyDist");

  for (const component of components) {
    const kind = String(component.kind || "").toLowerCase();
    const profile = COMPONENT_PROFILES[kind];
    if (!profile) {
      warnings.push(`Unsupported component kind: ${kind || "unknown"}. It was ignored.`);
      continue;
    }
    assumptions.push({ component: component.name || kind, kind, assumption: profile.assumption });

    if (profile.group === "control") {
      const latency = component.latencyMs ?? 0;
      const jitter = component.jitterMs ?? 0;
      controlLatency += latency;
      controlLatencyVar += jitter * jitter;
      if (component.rateLimiter && Array.isArray(component.rateLimiter.windows)) {
        if (component.rateLimiter.type) config.limiterType = component.rateLimiter.type;
        for (const window of component.rateLimiter.windows) {
          windows.push({ windowMs: window.windowMs, limit: window.limit });
        }
      }
      continue;
    }

    if (profile.group === "app") {
      appSeen = true;
      ingestStageComponent(appStage, component, warnings, "app-stage");
      continue;
    }

    if (profile.group === "dependency") {
      depSeen = true;
      ingestStageComponent(depStage, component, warnings, "dependency-stage");
    }
  }

  config.rlLatA = Math.max(1, controlLatency || config.rlLatA);
  config.rlLatB = Math.max(0, Math.sqrt(controlLatencyVar) || config.rlLatB);
  applyStageAccumulator(
    config,
    appStage,
    {
      latency: "latA",
      jitter: "latB",
      dist: "latencyDist",
      maxConcurrent: "maxConcurrent",
      queueCapacity: "queueCapacity",
      timeout: "maxQueueWaitMs"
    },
    warnings,
    "app-stage"
  );
  applyStageAccumulator(
    config,
    depStage,
    {
      latency: "depLatA",
      jitter: "depLatB",
      dist: "depLatencyDist",
      maxConcurrent: "depMaxConcurrent",
      queueCapacity: "depQueueCapacity",
      timeout: "depMaxQueueWaitMs"
    },
    warnings,
    "dependency-stage"
  );
  if (windows.length) config.windows = windows;
  if (!appSeen) warnings.push("No explicit app component provided. Default app capacity assumptions were used.");
  if (!depSeen) warnings.push("No explicit dependency component provided. Default downstream assumptions were used.");
  warnings.push(...reviewRateLimitConfig(config));

  return {
    config,
    assumptions,
    warnings,
    collapse: {
      control: {
        componentCount: assumptions.filter((item) => COMPONENT_PROFILES[item.kind].group === "control").length,
        latencyMs: round(config.rlLatA),
        jitterMs: round(config.rlLatB),
        windows: config.windows
      },
      app: {
        components: appStage.components,
        latencyMs: round(config.latA),
        jitterMs: round(config.latB),
        latencyDist: config.latencyDist,
        maxConcurrent: config.maxConcurrent,
        queueCapacity: config.queueCapacity,
        timeoutMs: config.maxQueueWaitMs
      },
      dependency: {
        components: depStage.components,
        latencyMs: round(config.depLatA),
        jitterMs: round(config.depLatB),
        latencyDist: config.depLatencyDist,
        maxConcurrent: config.depMaxConcurrent,
        queueCapacity: config.depQueueCapacity,
        timeoutMs: config.depMaxQueueWaitMs
      }
    }
  };
}

function simulateScenario(input = {}) {
  const config = mergeConfig(defaultSimulationConfig(), input.config || input);
  const result = runSimulation(config);
  return {
    config,
    summary: summarizeResult(result),
    warnings: reviewRateLimitConfig(config),
    result
  };
}

function compareScenarios(input = {}) {
  const base = simulateScenario({ config: input.base });
  const candidate = simulateScenario({ config: input.candidate });
  return {
    base: base.summary,
    candidate: candidate.summary,
    delta: {
      served: candidate.summary.served - base.summary.served,
      rate429: candidate.summary.rate429 - base.summary.rate429,
      rate503: candidate.summary.rate503 - base.summary.rate503,
      enteredApp: candidate.summary.enteredApp - base.summary.enteredApp,
      enteredDependency: candidate.summary.enteredDependency - base.summary.enteredDependency,
      p95: round(candidate.summary.p95 - base.summary.p95),
      peakAppQueue: candidate.summary.peakAppQueue - base.summary.peakAppQueue,
      peakDepQueue: candidate.summary.peakDepQueue - base.summary.peakDepQueue,
      protectionPct: round(candidate.summary.protectionPct - base.summary.protectionPct),
      appLoadAvoided: candidate.summary.appLoadAvoided - base.summary.appLoadAvoided,
      dependencyLoadAvoided: candidate.summary.dependencyLoadAvoided - base.summary.dependencyLoadAvoided
    },
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
