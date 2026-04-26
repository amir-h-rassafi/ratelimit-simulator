function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normal(mean, std) {
  const u1 = Math.random() || 1e-7;
  const u2 = Math.random() || 1e-7;
  return mean + Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * std;
}

function poisson(lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 50) return Math.max(0, Math.round(normal(lambda, Math.sqrt(lambda))));
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do { k += 1; p *= Math.random(); } while (p > l);
  return k - 1;
}

const LATENCY_SAMPLERS = {
  constant: (a) => Math.max(1, a),
  uniform: (a, b) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return Math.max(1, lo + Math.random() * (hi - lo));
  },
  normal: (a, b) => Math.max(1, normal(a, Math.max(1, b))),
  lognormal: (a, b) => Math.max(1, Math.exp(normal(a, Math.max(0.01, b)))),
  exponential: (a) => Math.max(1, -Math.log(1 - Math.random()) * Math.max(1, a))
};

function sampleLatencyMs(dist, a, b) {
  return (LATENCY_SAMPLERS[dist] || LATENCY_SAMPLERS.constant)(a, b);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = clamp(Math.ceil((p / 100) * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[idx];
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
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
  canAllow(tMs) { this.refresh(tMs); return this.count < this.limit; }
  commit(tMs) { this.refresh(tMs); this.count += 1; }
  countAt(tMs) { this.refresh(tMs); return this.count; }
}

// Sliding window keeps events sorted ascending by timestamp so evict is a
// monotonic prefix scan. Commits use binary insertion so the invariant
// survives any out-of-order arrivals from the caller.
class SlidingWindowLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.events = [];
  }
  evict(tMs) {
    const floor = tMs - this.windowMs;
    let drop = 0;
    while (drop < this.events.length && this.events[drop] <= floor) drop += 1;
    if (drop) this.events.splice(0, drop);
  }
  canAllow(tMs) { this.evict(tMs); return this.events.length < this.limit; }
  commit(tMs) {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.events[mid] <= tMs) lo = mid + 1; else hi = mid;
    }
    this.events.splice(lo, 0, tMs);
  }
  countAt(tMs) { this.evict(tMs); return this.events.length; }
}

function createLimiter(type, limit, windowMs) {
  return type === "sliding"
    ? new SlidingWindowLimiter(limit, windowMs)
    : new FixedWindowLimiter(limit, windowMs);
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
    durationSec, stepMs, rps, burstiness, trafficNoise = false,
    wsMaxConcurrent = Number.POSITIVE_INFINITY,
    wsQueueCapacity = Number.POSITIVE_INFINITY,
    wsMaxQueueWaitMs = Number.POSITIVE_INFINITY,
    wsRequestTimeoutMs = Number.POSITIVE_INFINITY,
    maxConcurrent, queueCapacity, maxQueueWaitMs,
    limiterType, windows,
    rlFailureMode = "fail_closed",
    rlLatencyDist, rlLatA, rlLatB,
    rlMaxConcurrent = Number.POSITIVE_INFINITY,
    rlQueueCapacity = Number.POSITIVE_INFINITY,
    rlMaxQueueWaitMs = Number.POSITIVE_INFINITY,
    latencyDist, latA, latB,
    depMaxConcurrent,
    depLatencyDist, depLatA, depLatB
  } = cfg;

  const limiters = windows.map((w) => createLimiter(limiterType, w.limit, w.windowMs));
  const windowSeries = makeWindowSeries(windows);
  const steps = Math.floor((durationSec * 1000) / stepMs);

  const appInflight = [];
  const appQueue = [];
  const depInflight = [];
  const wsActive = [];
  const wsQueue = [];
  const limiterInflight = [];
  const limiterQueue = [];
  const limiterLatencies = [];
  const latencyByStatus = { s200: [], s429: [], s503: [] };
  const timeline = [];

  const totals = {
    arrived: 0, enteredWebserver: 0, enteredLimiter: 0, enteredApp: 0, enteredDependency: 0, served: 0, delayedServed: 0,
    rate429: 0, rate503: 0,
    wsDroppedFull: 0, wsDroppedWait: 0, wsDroppedTimeout: 0,
    limiterDroppedFull: 0, limiterDroppedWait: 0, limiterBypassed: 0,
    appDroppedFull: 0, appDroppedWait: 0,
    depDroppedFull: 0, depDroppedWait: 0
  };
  const peaks = {
    wsQueue: 0, wsActive: 0,
    limiterPending: 0, limiterQueue: 0, limiterInflight: 0,
    appQueue: 0, appInflight: 0, depInflight: 0
  };

  let sumLatency = 0;
  let sumQueueDelay = 0;
  let trafficArrivalAccumulator = 0;
  let nextReqId = 1;

  function completeWebserver(req) {
    if (!req || req.id == null) return false;
    const idx = wsActive.findIndex((active) => active.id === req.id);
    if (idx < 0) return false;
    wsActive.splice(idx, 1);
    return true;
  }

  function removeById(items, id) {
    const idx = items.findIndex((item) => item.id === id);
    if (idx >= 0) items.splice(idx, 1);
  }

  function removeDownstreamWork(id) {
    removeById(limiterQueue, id);
    removeById(limiterInflight, id);
    removeById(appQueue, id);
    removeById(appInflight, id);
    removeById(depInflight, id);
  }

  function record503(req, latencyMs) {
    totals.rate503 += 1;
    latencyByStatus.s503.push(Math.max(0, latencyMs));
  }

  function recordWebserverTimeout(req) {
    if (!completeWebserver(req)) return false;
    removeDownstreamWork(req.id);
    totals.wsDroppedTimeout += 1;
    record503(req, req.wsDeadlineMs - req.arrivalMs);
    return true;
  }

  function expireWebserverTimeouts(now) {
    let dropped = 0;
    for (let i = wsActive.length - 1; i >= 0; i -= 1) {
      const req = wsActive[i];
      if (now <= req.wsDeadlineMs) continue;
      if (recordWebserverTimeout(req)) dropped += 1;
    }
    return dropped;
  }

  function admitWebserver(now, req) {
    if (wsActive.length < wsMaxConcurrent) {
      wsActive.push(req);
      totals.enteredWebserver += 1;
      return admitLimiter(now, req);
    }
    if (wsQueue.length < wsQueueCapacity) {
      wsQueue.push({ ...req, queuedAtMs: now });
      totals.enteredWebserver += 1;
      return true;
    }
    totals.wsDroppedFull += 1;
    record503(req, now - req.arrivalMs);
    return false;
  }

  function promoteWebserverQueue(now) {
    let dropped = 0;
    while (wsQueue.length && wsActive.length < wsMaxConcurrent) {
      const req = wsQueue.shift();
      wsActive.push(req);
      const entered = admitLimiter(now, req);
      if (!entered) dropped += 1;
    }
    return dropped;
  }

  // Admit to app. `now` is decisionTime — the moment the request leaves the
  // limiter and either starts processing or joins the app queue.
  function admitApp(now, req) {
    if (appInflight.length < maxConcurrent) {
      const serviceMs = sampleLatencyMs(latencyDist, latA, latB);
      appInflight.push({
        id: req.id,
        arrivalMs: req.arrivalMs,
        wsDeadlineMs: req.wsDeadlineMs,
        endMs: now + serviceMs,
        appServiceMs: serviceMs,
        limiterWaitMs: req.limiterWaitMs,
        appQueueWaitMs: 0
      });
      totals.enteredApp += 1;
      return true;
    }
    if (appQueue.length < queueCapacity) {
      appQueue.push({ ...req, queuedAtMs: now });
      totals.enteredApp += 1;
      return true;
    }
    totals.appDroppedFull += 1;
    record503(req, now - req.arrivalMs);
    completeWebserver(req);
    return false;
  }

  function startLimiterDecision(now, req) {
    const decisionLatencyMs = sampleLatencyMs(rlLatencyDist, rlLatA, rlLatB);
    limiterInflight.push({
      id: req.id,
      decisionReadyMs: now + decisionLatencyMs,
      arrivalMs: req.arrivalMs,
      wsDeadlineMs: req.wsDeadlineMs,
      limiterQueueWaitMs: req.limiterQueueWaitMs || 0
    });
    limiterLatencies.push(decisionLatencyMs);
  }

  function admitLimiter(now, req) {
    totals.enteredLimiter += 1;
    if (limiterInflight.length < rlMaxConcurrent) {
      startLimiterDecision(now, req);
      return true;
    }
    if (limiterQueue.length < rlQueueCapacity) {
      limiterQueue.push({ ...req, queuedAtMs: now });
      return true;
    }
    if (rlFailureMode === "bypass") {
      totals.limiterBypassed += 1;
      return admitApp(now, { ...req, limiterWaitMs: now - req.arrivalMs });
    }
    totals.limiterDroppedFull += 1;
    record503(req, now - req.arrivalMs);
    completeWebserver(req);
    return false;
  }

  function promoteLimiterQueue(now) {
    while (limiterQueue.length && limiterInflight.length < rlMaxConcurrent) {
      const req = limiterQueue.shift();
      startLimiterDecision(now, {
        id: req.id,
        arrivalMs: req.arrivalMs,
        wsDeadlineMs: req.wsDeadlineMs,
        limiterQueueWaitMs: now - req.queuedAtMs
      });
    }
  }

  function admitDependency(now, req) {
    if (depInflight.length < depMaxConcurrent) {
      const serviceMs = sampleLatencyMs(depLatencyDist, depLatA, depLatB);
      depInflight.push({
        id: req.id,
        arrivalMs: req.arrivalMs,
        wsDeadlineMs: req.wsDeadlineMs,
        endMs: now + serviceMs,
        depServiceMs: serviceMs,
        limiterWaitMs: req.limiterWaitMs,
        appQueueWaitMs: req.appQueueWaitMs,
        appServiceMs: req.appServiceMs,
      });
      totals.enteredDependency += 1;
      return true;
    }
    totals.depDroppedFull += 1;
    record503(req, now - req.arrivalMs);
    completeWebserver(req);
    return false;
  }

  for (let step = 0; step <= steps; step += 1) {
    const now = step * stepMs;
    const bucketEnd = now + stepMs;
    let step429 = 0;
    let step503 = 0;
    let stepAccepted = 0;

    // 1. Complete dependency inflight → served
    for (let i = depInflight.length - 1; i >= 0; i -= 1) {
      if (depInflight[i].endMs > now) continue;
      const r = depInflight[i];
      depInflight.splice(i, 1);
      if (r.endMs > r.wsDeadlineMs) {
        if (recordWebserverTimeout(r)) step503 += 1;
        continue;
      }
      completeWebserver(r);
      totals.served += 1;
      const queueDelay = r.appQueueWaitMs;
      if (queueDelay > 0) totals.delayedServed += 1;
      const totalLat = r.endMs - r.arrivalMs;
      latencyByStatus.s200.push(totalLat);
      sumLatency += totalLat;
      sumQueueDelay += queueDelay;
    }

    // 2. Expire webserver-owned requests whose end-to-end deadline has passed.
    step503 += expireWebserverTimeouts(now);

    // 3. Complete app inflight → try dependency admission
    for (let i = appInflight.length - 1; i >= 0; i -= 1) {
      if (appInflight[i].endMs > now) continue;
      const r = appInflight[i];
      appInflight.splice(i, 1);
      if (r.endMs > r.wsDeadlineMs) {
        if (recordWebserverTimeout(r)) step503 += 1;
        continue;
      }
      const entered = admitDependency(now, {
        id: r.id,
        arrivalMs: r.arrivalMs,
        wsDeadlineMs: r.wsDeadlineMs,
        limiterWaitMs: r.limiterWaitMs,
        appQueueWaitMs: r.appQueueWaitMs,
        appServiceMs: r.appServiceMs
      });
      if (!entered) step503 += 1;
    }

    // 4. Expire app queue timeouts (measured from queue entry, not arrival)
    for (let i = appQueue.length - 1; i >= 0; i -= 1) {
      const r = appQueue[i];
      if (now - r.queuedAtMs < maxQueueWaitMs) continue;
      appQueue.splice(i, 1);
      totals.appDroppedWait += 1;
      step503 += 1;
      record503(r, now - r.arrivalMs);
      completeWebserver(r);
    }

    // 5. Promote app queue → app inflight
    while (appQueue.length && appInflight.length < maxConcurrent) {
      const r = appQueue.shift();
      const serviceMs = sampleLatencyMs(latencyDist, latA, latB);
      appInflight.push({
        id: r.id,
        arrivalMs: r.arrivalMs,
        wsDeadlineMs: r.wsDeadlineMs,
        endMs: now + serviceMs,
        appServiceMs: serviceMs,
        limiterWaitMs: r.limiterWaitMs,
        appQueueWaitMs: now - r.queuedAtMs
      });
    }

    // 6. Expire limiter queue timeouts
    for (let i = limiterQueue.length - 1; i >= 0; i -= 1) {
      const req = limiterQueue[i];
      if (now - req.queuedAtMs < rlMaxQueueWaitMs) continue;
      limiterQueue.splice(i, 1);
      if (rlFailureMode === "bypass") {
        totals.limiterBypassed += 1;
        const entered = admitApp(now, { ...req, limiterWaitMs: now - req.arrivalMs });
        if (!entered) step503 += 1;
      } else {
        totals.limiterDroppedWait += 1;
        step503 += 1;
        record503(req, now - req.arrivalMs);
        completeWebserver(req);
      }
    }

    // 7. Promote limiter queue → limiter inflight
    promoteLimiterQueue(now);

    // 8. Expire and promote requests waiting at the webserver boundary.
    for (let i = wsQueue.length - 1; i >= 0; i -= 1) {
      const req = wsQueue[i];
      if (now > req.wsDeadlineMs) {
        wsQueue.splice(i, 1);
        totals.wsDroppedTimeout += 1;
        step503 += 1;
        record503(req, req.wsDeadlineMs - req.arrivalMs);
      } else if (now - req.queuedAtMs >= wsMaxQueueWaitMs) {
        wsQueue.splice(i, 1);
        totals.wsDroppedWait += 1;
        step503 += 1;
        record503(req, now - req.arrivalMs);
      }
    }
    step503 += promoteWebserverQueue(now);

    // 9. Generate arrivals and enqueue webserver-owned requests.
    const expectedRps = expectedTrafficRpsAt(step, steps, rps, burstiness);
    const expectedInStep = Math.max(0, (expectedRps * stepMs) / 1000);
    let arrivals;
    if (trafficNoise) {
      arrivals = poisson(expectedInStep);
    } else {
      trafficArrivalAccumulator += expectedInStep;
      arrivals = Math.floor(trafficArrivalAccumulator);
      trafficArrivalAccumulator -= arrivals;
    }
    for (let i = 0; i < arrivals; i += 1) {
      const req = {
        id: nextReqId,
        arrivalMs: now,
        wsDeadlineMs: now + wsRequestTimeoutMs
      };
      nextReqId += 1;
      const entered = admitWebserver(now, req);
      if (!entered) step503 += 1;
    }
    totals.arrived += arrivals;

    // 10. Process limiter decisions in chronological order. Sorting by
    // decisionReadyMs is what makes the sliding window correct under
    // jittered decision latencies.
    limiterInflight.sort((a, b) => a.decisionReadyMs - b.decisionReadyMs);
    let readyCount = 0;
    while (readyCount < limiterInflight.length && limiterInflight[readyCount].decisionReadyMs <= bucketEnd) {
      readyCount += 1;
    }
    const ready = limiterInflight.splice(0, readyCount);
    for (const pending of ready) {
      const decisionTime = pending.decisionReadyMs;
      if (decisionTime > pending.wsDeadlineMs) {
        if (recordWebserverTimeout(pending)) step503 += 1;
        continue;
      }
      const blockedIdx = limiters.findIndex((lim) => !lim.canAllow(decisionTime));
      if (blockedIdx >= 0) {
        totals.rate429 += 1;
        step429 += 1;
        windowSeries[blockedIdx].blocked += 1;
        latencyByStatus.s429.push(decisionTime - pending.arrivalMs);
        completeWebserver(pending);
        continue;
      }
      for (const lim of limiters) lim.commit(decisionTime);
      stepAccepted += 1;
      const entered = admitApp(decisionTime, {
        id: pending.id,
        arrivalMs: pending.arrivalMs,
        wsDeadlineMs: pending.wsDeadlineMs,
        limiterWaitMs: decisionTime - pending.arrivalMs
      });
      if (!entered) step503 += 1;
    }
    promoteLimiterQueue(bucketEnd);

    peaks.wsQueue = Math.max(peaks.wsQueue, wsQueue.length);
    peaks.wsActive = Math.max(peaks.wsActive, wsActive.length);
    peaks.limiterQueue = Math.max(peaks.limiterQueue, limiterQueue.length);
    peaks.limiterInflight = Math.max(peaks.limiterInflight, limiterInflight.length);
    peaks.limiterPending = Math.max(peaks.limiterPending, limiterInflight.length + limiterQueue.length);
    peaks.appQueue = Math.max(peaks.appQueue, appQueue.length);
    peaks.appInflight = Math.max(peaks.appInflight, appInflight.length);
    peaks.depInflight = Math.max(peaks.depInflight, depInflight.length);

    for (let i = 0; i < limiters.length; i += 1) {
      const count = limiters[i].countAt(now);
      const pct = windows[i].limit > 0 ? (100 * count) / windows[i].limit : 0;
      windowSeries[i].utilizationPct.push(clamp(pct, 0, 200));
    }

    const perSec = 1000 / stepMs;
    timeline.push({
      tSec: now / 1000,
      active: appInflight.length,
      queued: appQueue.length,
      depActive: depInflight.length,
      depQueued: 0,
      wsActive: wsActive.length,
      wsQueued: wsQueue.length,
      limiterActive: limiterInflight.length,
      limiterQueued: limiterQueue.length,
      limiterPending: limiterInflight.length + limiterQueue.length,
      expectedArrivalsPerSec: Math.round(expectedRps),
      arrivalsPerSec: Math.round(arrivals * perSec),
      acceptedPerSec: Math.round(stepAccepted * perSec),
      r429PerSec: Math.round(step429 * perSec),
      r503PerSec: Math.round(step503 * perSec)
    });
  }

  const sortedLatencies = [...latencyByStatus.s200].sort((a, b) => a - b);
  latencyByStatus.s429.sort((a, b) => a - b);
  latencyByStatus.s503.sort((a, b) => a - b);
  const sortedLimiterLatencies = [...limiterLatencies].sort((a, b) => a - b);

  const pct = (num, den) => (den ? (100 * num) / den : 0);
  return {
    totals: {
      ...totals,
      // Rolled-up aliases kept for back-compat; prefer per-stage fields above.
      droppedFull: totals.wsDroppedFull + totals.limiterDroppedFull + totals.appDroppedFull + totals.depDroppedFull,
      droppedWait: totals.wsDroppedWait + totals.limiterDroppedWait + totals.appDroppedWait + totals.depDroppedWait,
      droppedTimeout: totals.wsDroppedTimeout,
      servedPct: pct(totals.served, totals.arrived),
      rate503Pct: pct(totals.rate503, totals.arrived),
      rate429Pct: pct(totals.rate429, totals.arrived)
    },
    latency: {
      avg: totals.served ? sumLatency / totals.served : 0,
      avgQueueDelay: totals.served ? sumQueueDelay / totals.served : 0,
      p50: percentile(sortedLatencies, 50),
      p95: percentile(sortedLatencies, 95),
      p99: percentile(sortedLatencies, 99),
      samples: sortedLatencies,
      byStatus: latencyByStatus
    },
    limiterLatency: {
      avg: mean(sortedLimiterLatencies),
      p95: percentile(sortedLimiterLatencies, 95),
      p99: percentile(sortedLimiterLatencies, 99),
      peakPending: peaks.limiterPending
    },
    queues: {
      peakWsQueue: peaks.wsQueue,
      peakWsActive: peaks.wsActive,
      peakLimiterPending: peaks.limiterPending,
      peakLimiterQueue: peaks.limiterQueue,
      peakLimiterInflight: peaks.limiterInflight,
      peakAppQueue: peaks.appQueue,
      peakDepQueue: 0,
      peakAppInflight: peaks.appInflight,
      peakDepInflight: peaks.depInflight
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
