function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normal(mean, std) {
  const u1 = Math.random() || 1e-7;
  const u2 = Math.random() || 1e-7;
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * std;
}

function poisson(lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 50) {
    return Math.max(0, Math.round(normal(lambda, Math.sqrt(lambda))));
  }
  const l = Math.exp(-lambda);
  let p = 1;
  let k = 0;
  do {
    k += 1;
    p *= Math.random();
  } while (p > l);
  return k - 1;
}

function sampleLatencyMs(dist, a, b) {
  if (dist === "constant") return Math.max(1, a);
  if (dist === "uniform") {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return Math.max(1, lo + Math.random() * (hi - lo));
  }
  if (dist === "normal") return Math.max(1, normal(a, Math.max(1, b)));
  if (dist === "lognormal") {
    const x = normal(a, Math.max(0.01, b));
    return Math.max(1, Math.exp(x));
  }
  if (dist === "exponential") {
    const mean = Math.max(1, a);
    return Math.max(1, -Math.log(1 - Math.random()) * mean);
  }
  return Math.max(1, a);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[clamp(idx, 0, sorted.length - 1)];
}

function trafficWaveMultiplier(step, steps, burstiness) {
  const phase = (2 * Math.PI * step) / Math.max(10, steps / 2);
  return Math.max(0, 1 + burstiness * Math.sin(phase));
}

function expectedTrafficRpsAt(step, steps, rps, burstiness) {
  return Math.max(0, rps * trafficWaveMultiplier(step, steps, burstiness));
}

class FixedWindowLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.windowStart = 0;
    this.count = 0;
  }

  refresh(tMs) {
    if (tMs >= this.windowStart + this.windowMs) {
      this.windowStart = Math.floor(tMs / this.windowMs) * this.windowMs;
      this.count = 0;
    }
  }

  canAllow(tMs) {
    this.refresh(tMs);
    return this.count < this.limit;
  }

  commit(tMs) {
    this.refresh(tMs);
    this.count += 1;
  }

  countAt(tMs) {
    this.refresh(tMs);
    return this.count;
  }
}

class SlidingWindowLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.events = [];
    this.head = 0;
  }

  evict(tMs) {
    const floor = tMs - this.windowMs;
    while (this.head < this.events.length && this.events[this.head] <= floor) {
      this.head += 1;
    }
    if (this.head > 2000 && this.head * 2 > this.events.length) {
      this.events = this.events.slice(this.head);
      this.head = 0;
    }
  }

  canAllow(tMs) {
    this.evict(tMs);
    return this.events.length - this.head < this.limit;
  }

  commit(tMs) {
    this.evict(tMs);
    this.events.push(tMs);
  }

  countAt(tMs) {
    this.evict(tMs);
    return this.events.length - this.head;
  }
}

function createLimiter(type, limit, windowMs) {
  if (type === "sliding") return new SlidingWindowLimiter(limit, windowMs);
  return new FixedWindowLimiter(limit, windowMs);
}

function makeWindowSeries(windows) {
  return windows.map((w, idx) => ({
    id: idx,
    label: `${Math.round(w.windowMs / 1000)}s/${w.limit}`,
    windowMs: w.windowMs,
    limit: w.limit,
    utilizationPct: [],
    blocked: 0
  }));
}

function runSimulation(cfg) {
  const {
    durationSec,
    stepMs,
    rps,
    burstiness,
    trafficNoise = false,
    maxConcurrent,
    queueCapacity,
    maxQueueWaitMs,
    limiterType,
    windows,
    rlLatencyDist,
    rlLatA,
    rlLatB,
    latencyDist,
    latA,
    latB,
    depMaxConcurrent,
    depQueueCapacity,
    depMaxQueueWaitMs,
    depLatencyDist,
    depLatA,
    depLatB
  } = cfg;

  const limiters = windows.map((w) => createLimiter(limiterType, w.limit, w.windowMs));
  const windowSeries = makeWindowSeries(windows);

  const steps = Math.floor((durationSec * 1000) / stepMs);
  const appInflight = [];
  const appQueue = [];
  const depInflight = [];
  const depQueue = [];
  const limiterPending = [];
  const latencies = [];
  const latencyByStatus = { s200: [], s429: [], s503: [] };
  const limiterLatencies = [];

  const timeline = [];
  let totalArrived = 0;
  let totalServed = 0;
  let totalDelayedServed = 0;
  let total429 = 0;
  let total503 = 0;
  let totalDroppedFull = 0;
  let totalDroppedWait = 0;
  let totalDepDroppedFull = 0;
  let totalDepDroppedWait = 0;
  let totalEnteredApp = 0;
  let totalEnteredDependency = 0;
  let sumLatency = 0;
  let sumQueueDelay = 0;
  let peakLimiterPending = 0;
  let trafficArrivalAccumulator = 0;
  let peakAppQueue = 0;
  let peakDepQueue = 0;
  let peakAppInflight = 0;
  let peakDepInflight = 0;

  function startDependency(now, req) {
    if (depInflight.length < depMaxConcurrent) {
      const depServiceMs = sampleLatencyMs(depLatencyDist, depLatA, depLatB);
      depInflight.push({
        endMs: now + depServiceMs,
        depServiceMs,
        appServiceMs: req.appServiceMs,
        appQueueDelayMs: req.appQueueDelayMs,
        depQueueDelayMs: now - req.depArrivalMs
      });
      totalEnteredDependency += 1;
      return true;
    }

    if (depQueue.length < depQueueCapacity) {
      depQueue.push(req);
      totalEnteredDependency += 1;
      return true;
    }

    total503 += 1;
    totalDroppedFull += 1;
    totalDepDroppedFull += 1;
    latencyByStatus.s503.push(req.appQueueDelayMs + req.appServiceMs);
    return false;
  }

  function startApp(now, req) {
    if (appInflight.length < maxConcurrent) {
      const appServiceMs = sampleLatencyMs(latencyDist, latA, latB);
      appInflight.push({
        endMs: now + appServiceMs,
        appServiceMs,
        appQueueDelayMs: now - req.arrivalMs
      });
      totalEnteredApp += 1;
      return true;
    }

    if (appQueue.length < queueCapacity) {
      appQueue.push(req);
      totalEnteredApp += 1;
      return true;
    }

    total503 += 1;
    totalDroppedFull += 1;
    latencyByStatus.s503.push(now - req.arrivalMs);
    return false;
  }

  for (let step = 0; step <= steps; step += 1) {
    const now = step * stepMs;
    const bucketEnd = now + stepMs;
    let step429 = 0;
    let step503 = 0;
    let stepAccepted = 0;

    for (let i = depInflight.length - 1; i >= 0; i -= 1) {
      if (depInflight[i].endMs <= now) {
        const req = depInflight[i];
        depInflight.splice(i, 1);
        totalServed += 1;
        const totalQueueDelay = req.appQueueDelayMs + req.depQueueDelayMs;
        if (totalQueueDelay > 0) totalDelayedServed += 1;
        const totalLat = req.appServiceMs + req.depServiceMs + totalQueueDelay;
        latencies.push(totalLat);
        latencyByStatus.s200.push(totalLat);
        sumLatency += totalLat;
        sumQueueDelay += totalQueueDelay;
      }
    }

    for (let i = depQueue.length - 1; i >= 0; i -= 1) {
      if (now - depQueue[i].depArrivalMs >= depMaxQueueWaitMs) {
        const req = depQueue[i];
        depQueue.splice(i, 1);
        total503 += 1;
        totalDroppedWait += 1;
        totalDepDroppedWait += 1;
        latencyByStatus.s503.push((now - req.depArrivalMs) + req.appQueueDelayMs + req.appServiceMs);
        step503 += 1;
      }
    }

    while (depQueue.length > 0 && depInflight.length < depMaxConcurrent) {
      const req = depQueue.shift();
      const depServiceMs = sampleLatencyMs(depLatencyDist, depLatA, depLatB);
      depInflight.push({
        endMs: now + depServiceMs,
        depServiceMs,
        appServiceMs: req.appServiceMs,
        appQueueDelayMs: req.appQueueDelayMs,
        depQueueDelayMs: now - req.depArrivalMs
      });
    }

    for (let i = appInflight.length - 1; i >= 0; i -= 1) {
      if (appInflight[i].endMs <= now) {
        const req = appInflight[i];
        appInflight.splice(i, 1);
        const entered = startDependency(now, {
          depArrivalMs: now,
          appServiceMs: req.appServiceMs,
          appQueueDelayMs: req.appQueueDelayMs
        });
        if (!entered) step503 += 1;
      }
    }

    for (let i = appQueue.length - 1; i >= 0; i -= 1) {
      if (now - appQueue[i].arrivalMs >= maxQueueWaitMs) {
        const req = appQueue[i];
        appQueue.splice(i, 1);
        total503 += 1;
        totalDroppedWait += 1;
        latencyByStatus.s503.push(now - req.arrivalMs);
        step503 += 1;
      }
    }

    while (appQueue.length > 0 && appInflight.length < maxConcurrent) {
      const req = appQueue.shift();
      const appServiceMs = sampleLatencyMs(latencyDist, latA, latB);
      appInflight.push({
        endMs: now + appServiceMs,
        appServiceMs,
        appQueueDelayMs: now - req.arrivalMs
      });
    }

    const expectedRps = expectedTrafficRpsAt(step, steps, rps, burstiness);
    const expectedInStep = (expectedRps * stepMs) / 1000;
    let arrivals = 0;
    if (trafficNoise) {
      arrivals = poisson(Math.max(0, expectedInStep));
    } else {
      trafficArrivalAccumulator += Math.max(0, expectedInStep);
      arrivals = Math.floor(trafficArrivalAccumulator);
      trafficArrivalAccumulator -= arrivals;
    }

    for (let i = 0; i < arrivals; i += 1) {
      const decisionLatencyMs = sampleLatencyMs(rlLatencyDist, rlLatA, rlLatB);
      limiterPending.push({
        decisionReadyMs: now + decisionLatencyMs,
        decisionLatencyMs,
        arrivalMs: now
      });
      limiterLatencies.push(decisionLatencyMs);
    }
    totalArrived += arrivals;

    for (let i = limiterPending.length - 1; i >= 0; i -= 1) {
      if (limiterPending[i].decisionReadyMs > bucketEnd) continue;
      const pendingReq = limiterPending[i];
      limiterPending.splice(i, 1);
      const decisionTime = pendingReq.decisionReadyMs;

      let blockedIdx = -1;
      for (let j = 0; j < limiters.length; j += 1) {
        if (!limiters[j].canAllow(decisionTime)) {
          blockedIdx = j;
          break;
        }
      }

      if (blockedIdx >= 0) {
        total429 += 1;
        step429 += 1;
        latencyByStatus.s429.push(decisionTime - pendingReq.arrivalMs);
        windowSeries[blockedIdx].blocked += 1;
        continue;
      }

      for (let j = 0; j < limiters.length; j += 1) {
        limiters[j].commit(decisionTime);
      }
      stepAccepted += 1;

      const entered = startApp(decisionTime, { arrivalMs: pendingReq.arrivalMs });
      if (!entered) step503 += 1;
    }

    peakLimiterPending = Math.max(peakLimiterPending, limiterPending.length);
    peakAppQueue = Math.max(peakAppQueue, appQueue.length);
    peakDepQueue = Math.max(peakDepQueue, depQueue.length);
    peakAppInflight = Math.max(peakAppInflight, appInflight.length);
    peakDepInflight = Math.max(peakDepInflight, depInflight.length);

    for (let i = 0; i < limiters.length; i += 1) {
      const count = limiters[i].countAt(now);
      const pct = windows[i].limit > 0 ? (100 * count) / windows[i].limit : 0;
      windowSeries[i].utilizationPct.push(clamp(pct, 0, 200));
    }

    timeline.push({
      tSec: now / 1000,
      active: appInflight.length,
      queued: appQueue.length,
      depActive: depInflight.length,
      depQueued: depQueue.length,
      limiterPending: limiterPending.length,
      expectedArrivalsPerSec: Math.round(expectedRps),
      arrivalsPerSec: Math.round((arrivals * 1000) / stepMs),
      acceptedPerSec: Math.round((stepAccepted * 1000) / stepMs),
      r429PerSec: Math.round((step429 * 1000) / stepMs),
      r503PerSec: Math.round((step503 * 1000) / stepMs)
    });
  }

  latencies.sort((a, b) => a - b);
  latencyByStatus.s200.sort((a, b) => a - b);
  latencyByStatus.s429.sort((a, b) => a - b);
  latencyByStatus.s503.sort((a, b) => a - b);
  limiterLatencies.sort((a, b) => a - b);
  const avgLatency = totalServed ? sumLatency / totalServed : 0;
  const avgQueueDelay = totalServed ? sumQueueDelay / totalServed : 0;
  const avgLimiterLatency = limiterLatencies.length
    ? limiterLatencies.reduce((acc, v) => acc + v, 0) / limiterLatencies.length
    : 0;

  return {
    totals: {
      arrived: totalArrived,
      enteredApp: totalEnteredApp,
      enteredDependency: totalEnteredDependency,
      served: totalServed,
      delayedServed: totalDelayedServed,
      droppedFull: totalDroppedFull,
      droppedWait: totalDroppedWait,
      depDroppedFull: totalDepDroppedFull,
      depDroppedWait: totalDepDroppedWait,
      rate503: total503,
      rate429: total429,
      servedPct: totalArrived ? (100 * totalServed) / totalArrived : 0,
      rate503Pct: totalArrived ? (100 * total503) / totalArrived : 0,
      rate429Pct: totalArrived ? (100 * total429) / totalArrived : 0,
      protectionPct: totalArrived ? (100 * total429) / totalArrived : 0
    },
    latency: {
      avg: avgLatency,
      avgQueueDelay,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      samples: latencies,
      byStatus: latencyByStatus
    },
    limiterLatency: {
      avg: avgLimiterLatency,
      p95: percentile(limiterLatencies, 95),
      p99: percentile(limiterLatencies, 99),
      peakPending: peakLimiterPending
    },
    queues: {
      peakLimiterPending,
      peakAppQueue,
      peakDepQueue,
      peakAppInflight,
      peakDepInflight
    },
    protection: {
      blockedByLimiter: total429,
      appLoadAvoided: total429,
      dependencyLoadAvoided: total429,
      protectionPct: totalArrived ? (100 * total429) / totalArrived : 0
    },
    windowSeries,
    timeline
  };
}


const simulationApi = {
  clamp,
  normal,
  poisson,
  sampleLatencyMs,
  percentile,
  FixedWindowLimiter,
  SlidingWindowLimiter,
  createLimiter,
  makeWindowSeries,
  trafficWaveMultiplier,
  expectedTrafficRpsAt,
  runSimulation
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = simulationApi;
}

if (typeof window !== "undefined") {
  Object.assign(window, simulationApi);
}
