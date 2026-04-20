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
    latB
  } = cfg;

  const limiters = windows.map((w) => createLimiter(limiterType, w.limit, w.windowMs));
  const windowSeries = makeWindowSeries(windows);

  const steps = Math.floor((durationSec * 1000) / stepMs);
  const inflight = [];
  const queue = [];
  const limiterPending = [];
  const latencies = [];
  const limiterLatencies = [];

  const timeline = [];
  let totalArrived = 0;
  let totalServed = 0;
  let totalDelayedServed = 0;
  let total429 = 0;
  let total503 = 0;
  let totalDroppedFull = 0;
  let totalDroppedWait = 0;
  let sumLatency = 0;
  let sumQueueDelay = 0;
  let peakLimiterPending = 0;

  for (let step = 0; step <= steps; step += 1) {
    const now = step * stepMs;
    let step429 = 0;
    let step503 = 0;
    let stepAccepted = 0;

    for (let i = inflight.length - 1; i >= 0; i -= 1) {
      if (inflight[i].endMs <= now) {
        const req = inflight[i];
        inflight.splice(i, 1);
        totalServed += 1;
        if (req.queueDelayMs > 0) totalDelayedServed += 1;
        const totalLat = req.serviceMs + req.queueDelayMs;
        latencies.push(totalLat);
        sumLatency += totalLat;
        sumQueueDelay += req.queueDelayMs;
      }
    }

    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (now - queue[i].arrivalMs >= maxQueueWaitMs) {
        queue.splice(i, 1);
        total503 += 1;
        totalDroppedWait += 1;
        step503 += 1;
      }
    }

    while (queue.length > 0 && inflight.length < maxConcurrent) {
      const q = queue.shift();
      const serviceMs = sampleLatencyMs(latencyDist, latA, latB);
      inflight.push({
        endMs: now + serviceMs,
        serviceMs,
        queueDelayMs: now - q.arrivalMs
      });
    }

    const phase = (2 * Math.PI * step) / Math.max(10, steps / 2);
    const trafficMultiplier = 1 + burstiness * Math.sin(phase);
    const expectedInStep = (rps * trafficMultiplier * stepMs) / 1000;
    const arrivals = poisson(Math.max(0, expectedInStep));

    for (let i = 0; i < arrivals; i += 1) {
      const decisionLatencyMs = sampleLatencyMs(rlLatencyDist, rlLatA, rlLatB);
      limiterPending.push({
        decisionReadyMs: now + decisionLatencyMs,
        decisionLatencyMs
      });
      limiterLatencies.push(decisionLatencyMs);
    }
    totalArrived += arrivals;

    for (let i = limiterPending.length - 1; i >= 0; i -= 1) {
      if (limiterPending[i].decisionReadyMs > now) continue;
      const pendingReq = limiterPending[i];
      limiterPending.splice(i, 1);

      let blockedIdx = -1;
      for (let j = 0; j < limiters.length; j += 1) {
        if (!limiters[j].canAllow(pendingReq.decisionReadyMs)) {
          blockedIdx = j;
          break;
        }
      }

      if (blockedIdx >= 0) {
        total429 += 1;
        step429 += 1;
        windowSeries[blockedIdx].blocked += 1;
        continue;
      }

      for (let j = 0; j < limiters.length; j += 1) {
        limiters[j].commit(pendingReq.decisionReadyMs);
      }
      stepAccepted += 1;

      if (inflight.length < maxConcurrent) {
        const serviceMs = sampleLatencyMs(latencyDist, latA, latB);
        inflight.push({ endMs: now + serviceMs, serviceMs, queueDelayMs: 0 });
      } else if (queue.length < queueCapacity) {
        queue.push({ arrivalMs: now });
      } else {
        total503 += 1;
        totalDroppedFull += 1;
        step503 += 1;
      }
    }
    peakLimiterPending = Math.max(peakLimiterPending, limiterPending.length);

    for (let i = 0; i < limiters.length; i += 1) {
      const count = limiters[i].countAt(now);
      const pct = windows[i].limit > 0 ? (100 * count) / windows[i].limit : 0;
      windowSeries[i].utilizationPct.push(clamp(pct, 0, 200));
    }

    timeline.push({
      tSec: now / 1000,
      active: inflight.length,
      queued: queue.length,
      limiterPending: limiterPending.length,
      arrivalsPerSec: Math.round((arrivals * 1000) / stepMs),
      acceptedPerSec: Math.round((stepAccepted * 1000) / stepMs),
      r429PerSec: Math.round((step429 * 1000) / stepMs),
      r503PerSec: Math.round((step503 * 1000) / stepMs)
    });
  }

  latencies.sort((a, b) => a - b);
  limiterLatencies.sort((a, b) => a - b);
  const avgLatency = totalServed ? sumLatency / totalServed : 0;
  const avgQueueDelay = totalServed ? sumQueueDelay / totalServed : 0;
  const avgLimiterLatency = limiterLatencies.length
    ? limiterLatencies.reduce((acc, v) => acc + v, 0) / limiterLatencies.length
    : 0;

  return {
    totals: {
      arrived: totalArrived,
      served: totalServed,
      delayedServed: totalDelayedServed,
      droppedFull: totalDroppedFull,
      droppedWait: totalDroppedWait,
      rate503: total503,
      rate429: total429,
      servedPct: totalArrived ? (100 * totalServed) / totalArrived : 0,
      rate503Pct: totalArrived ? (100 * total503) / totalArrived : 0,
      rate429Pct: totalArrived ? (100 * total429) / totalArrived : 0
    },
    latency: {
      avg: avgLatency,
      avgQueueDelay,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      samples: latencies
    },
    limiterLatency: {
      avg: avgLimiterLatency,
      p95: percentile(limiterLatencies, 95),
      p99: percentile(limiterLatencies, 99),
      peakPending: peakLimiterPending
    },
    windowSeries,
    timeline
  };
}
