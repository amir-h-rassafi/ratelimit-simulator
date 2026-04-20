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
  let totalDroppedWait = 0;
  let sumLatency = 0;
  let sumQueueDelay = 0;
  let peakLimiterPending = 0;

  for (let step = 0; step <= steps; step += 1) {
    const now = step * stepMs;

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
      if (now - queue[i].arrivalMs > maxQueueWaitMs) {
        queue.splice(i, 1);
        total429 += 1;
        totalDroppedWait += 1;
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

    let step429 = 0;
    let stepAccepted = 0;

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
        total429 += 1;
        step429 += 1;
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
      r429PerSec: Math.round((step429 * 1000) / stepMs)
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
      droppedWait: totalDroppedWait,
      rate429: total429,
      servedPct: totalArrived ? (100 * totalServed) / totalArrived : 0,
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

function formatNum(n) {
  return Number.isFinite(n) ? n.toLocaleString() : "0";
}

function formatMs(v) {
  return `${Math.round(v)} ms`;
}

function renderKpis(result) {
  const { totals, latency, limiterLatency, windowSeries } = result;
  const mostBlocked = windowSeries
    .map((w) => ({ label: w.label, blocked: w.blocked }))
    .sort((a, b) => b.blocked - a.blocked)[0];

  const items = [
    { name: "Arrived", value: formatNum(totals.arrived), kind: "neutral" },
    { name: "Served", value: `${formatNum(totals.served)} (${totals.servedPct.toFixed(1)}%)`, kind: "served" },
    { name: "Delayed Served", value: formatNum(totals.delayedServed), kind: "queue" },
    { name: "429 Total", value: `${formatNum(totals.rate429)} (${totals.rate429Pct.toFixed(1)}%)`, kind: "danger" },
    { name: "Queue Timeout 429", value: formatNum(totals.droppedWait), kind: "danger" },
    { name: "Limiter Rule", value: mostBlocked ? `${mostBlocked.label} (${formatNum(mostBlocked.blocked)})` : "No rules", kind: "queue" },
    { name: "Latency p95", value: formatMs(latency.p95), kind: "latency" },
    { name: "Avg Queue Delay", value: formatMs(latency.avgQueueDelay), kind: "queue" },
    { name: "Limiter Lat p95", value: formatMs(limiterLatency.p95), kind: "latency" },
    { name: "Limiter Pending Peak", value: formatNum(limiterLatency.peakPending), kind: "queue" }
  ];

  const kpiRoot = document.getElementById("kpis");
  kpiRoot.innerHTML = items.map(({ name, value, kind }) => (
    `<div class="kpi" data-kind="${kind}"><div class="name">${name}</div><div class="value">${value}</div></div>`
  )).join("");
}

function colorToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function niceChartMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const scaled = value / base;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return nice * base;
}

function drawAxes(ctx, w, h, pad, maxY, maxXLabel, yLabel) {
  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, "#ffffff");
  bg.addColorStop(1, "#ffffff");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "#edf0f2";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad + (i * innerH) / 4;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();

    const value = maxY - (i * maxY) / 4;
    ctx.fillStyle = "#5f6368";
    ctx.font = "12px Inter, Segoe UI, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(String(Math.round(value)), pad - 10, y + 4);
  }

  ctx.strokeStyle = "#dadce0";
  ctx.beginPath();
  ctx.moveTo(pad, h - pad);
  ctx.lineTo(w - pad, h - pad);
  ctx.stroke();

  ctx.fillStyle = "#5f6368";
  ctx.font = "12px Inter, Segoe UI, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(maxXLabel, w - pad - 36, h - 10);
  if (yLabel) ctx.fillText(yLabel, pad, 18);
}

function drawLineChart(canvasId, series, maxYOverride, yLabel, hoverIndex = null) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const pad = 46;
  const n = series.length ? series[0].values.length : 0;

  ctx.clearRect(0, 0, w, h);

  const rawMaxY = maxYOverride || Math.max(1, ...series.flatMap((s) => s.values));
  const maxY = niceChartMax(rawMaxY * 1.08);
  drawAxes(ctx, w, h, pad, maxY, "time", yLabel);

  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;
  const toX = (i) => pad + (i / Math.max(1, n - 1)) * innerW;
  const toY = (v) => pad + innerH - (v / maxY) * innerH;

  for (const s of series) {
    const points = s.values.map((v, i) => ({ x: toX(i), y: toY(v) }));
    if (!points.length) continue;

    if (s.fill) {
      const fill = ctx.createLinearGradient(0, pad, 0, h - pad);
      fill.addColorStop(0, colorToRgba(s.color, 0.13));
      fill.addColorStop(1, colorToRgba(s.color, 0));
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(points[0].x, h - pad);
      points.forEach((point) => ctx.lineTo(point.x, point.y));
      ctx.lineTo(points[points.length - 1].x, h - pad);
      ctx.closePath();
      ctx.fill();
    }

    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.emphasis ? 2.75 : 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i < points.length; i += 1) {
      if (i === 0) ctx.moveTo(points[i].x, points[i].y);
      else ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }

  if (hoverIndex !== null && n > 0) {
    const idx = clamp(hoverIndex, 0, n - 1);
    const x = toX(idx);
    ctx.strokeStyle = "#12171c";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, pad);
    ctx.lineTo(x, h - pad);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const s of series) {
      const value = s.values[idx];
      const y = toY(value);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    }
  }
}

function histogram(values, binCount) {
  if (!values.length) return { bins: [], max: 1 };
  const min = values[0];
  const max = values[values.length - 1];
  const width = Math.max(1, (max - min) / binCount);
  const bins = Array.from({ length: binCount }, (_, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    count: 0
  }));

  for (const v of values) {
    const idx = clamp(Math.floor((v - min) / width), 0, binCount - 1);
    bins[idx].count += 1;
  }

  return { bins, max: Math.max(1, ...bins.map((b) => b.count)) };
}

function drawLatencyAxis(ctx, w, h, pad, bins, maxCount) {
  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;
  const maxY = niceChartMax(maxCount);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "#edf0f2";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad + (i * innerH) / 4;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();

    const value = maxY - (i * maxY) / 4;
    ctx.fillStyle = "#5f6368";
    ctx.font = "12px Inter, Segoe UI, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(String(Math.round(value)), pad - 10, y + 4);
  }

  ctx.strokeStyle = "#dadce0";
  ctx.beginPath();
  ctx.moveTo(pad, h - pad);
  ctx.lineTo(w - pad, h - pad);
  ctx.stroke();

  ctx.fillStyle = "#5f6368";
  ctx.font = "12px Inter, Segoe UI, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("requests", pad, 18);
  ctx.fillText("latency (ms)", w - pad - 78, h - 10);

  if (!bins.length) return maxY;

  const min = bins[0].from;
  const max = bins[bins.length - 1].to;
  ctx.textAlign = "center";
  for (let i = 0; i <= 4; i += 1) {
    const x = pad + (i * innerW) / 4;
    const value = min + (i * (max - min)) / 4;
    ctx.fillText(`${Math.round(value)} ms`, x, h - pad + 22);
  }

  return maxY;
}

function drawLatencyHistogram(samples) {
  const canvas = document.getElementById("latencyChart");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const pad = 56;

  ctx.clearRect(0, 0, w, h);

  const { bins, max } = histogram(samples, 32);
  const maxY = drawLatencyAxis(ctx, w, h, pad, bins, max);

  if (!bins.length) return;

  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;
  const barW = innerW / bins.length;

  const fill = ctx.createLinearGradient(0, pad, 0, h - pad);
  fill.addColorStop(0, "#188038");
  fill.addColorStop(1, "rgba(24, 128, 56, 0.16)");
  ctx.fillStyle = fill;
  bins.forEach((b, i) => {
    const x = pad + i * barW + 2;
    const bh = (b.count / maxY) * innerH;
    const y = pad + innerH - bh;
    const bw = Math.max(1, barW - 4);
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, 3);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, bw, bh);
    }
  });
}

function buildDistributionPreview(dist, a, b) {
  const count = 48;
  const values = [];
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    let v = 0;
    if (dist === "constant") {
      v = i === Math.floor(count / 2) ? 1 : 0.08;
    } else if (dist === "uniform") {
      v = 1;
    } else if (dist === "normal") {
      const x = (t - 0.5) * 6;
      v = Math.exp(-0.5 * x * x);
    } else if (dist === "lognormal") {
      const x = 0.08 + t * 3.6;
      v = Math.exp(-((Math.log(x) - 0.15) ** 2) / 0.72) / x;
    } else if (dist === "exponential") {
      v = Math.exp(-t * 5);
    }
    values.push(v);
  }
  const max = Math.max(1e-7, ...values);
  return values.map((v) => v / max);
}

function distributionLabel(dist, a, b) {
  if (dist === "constant") return `Constant at ${Math.round(a)} ms`;
  if (dist === "uniform") return `Uniform ${Math.round(Math.min(a, b))}-${Math.round(Math.max(a, b))} ms`;
  if (dist === "normal") return `Gaussian mean ${Math.round(a)} ms, sigma ${Math.round(b)} ms`;
  if (dist === "lognormal") return `Log-normal mu ${a}, sigma ${b}`;
  if (dist === "exponential") return `Exponential mean ${Math.round(a)} ms`;
  return dist;
}

function distributionFieldCopy(dist, prefix = "") {
  const labelPrefix = prefix ? `${prefix} ` : "";
  if (dist === "constant") {
    return {
      aLabel: `${labelPrefix}latency`,
      aHelp: "milliseconds",
      bLabel: "Unused",
      bHelp: "ignored for constant distribution"
    };
  }
  if (dist === "uniform") {
    return {
      aLabel: "Minimum latency",
      aHelp: "milliseconds",
      bLabel: "Maximum latency",
      bHelp: "milliseconds"
    };
  }
  if (dist === "normal") {
    return {
      aLabel: "Mean latency",
      aHelp: "milliseconds",
      bLabel: "Std deviation",
      bHelp: "milliseconds"
    };
  }
  if (dist === "lognormal") {
    return {
      aLabel: "Log-space mean",
      aHelp: "mu",
      bLabel: "Log-space spread",
      bHelp: "sigma"
    };
  }
  if (dist === "exponential") {
    return {
      aLabel: "Mean latency",
      aHelp: "milliseconds",
      bLabel: "Unused",
      bHelp: "ignored for exponential distribution"
    };
  }
  return {
    aLabel: "Value A",
    aHelp: "distribution parameter",
    bLabel: "Value B",
    bHelp: "distribution parameter"
  };
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function updateDistributionFieldLabels() {
  const latencyCopy = distributionFieldCopy(document.getElementById("latencyDist").value);
  setText("latALabel", latencyCopy.aLabel);
  setText("latAHelp", latencyCopy.aHelp);
  setText("latBLabel", latencyCopy.bLabel);
  setText("latBHelp", latencyCopy.bHelp);

  const rlCopy = distributionFieldCopy(document.getElementById("rlLatencyDist").value, "Decision");
  setText("rlLatALabel", rlCopy.aLabel);
  setText("rlLatAHelp", rlCopy.aHelp);
  setText("rlLatBLabel", rlCopy.bLabel);
  setText("rlLatBHelp", rlCopy.bHelp);
}

function updateLimiterAlgorithmCopy() {
  const type = document.getElementById("limiterType").value;
  const text = type === "sliding"
    ? "Every cascaded row below uses sliding rolling windows: each counter covers the last N seconds."
    : "Every cascaded row below uses fixed window counters: each counter resets at the window boundary.";
  setText("limiterAlgorithmNote", text);
  updateWindowRowSummaries();
}

function drawDistributionPreview(canvasId, labelId, dist, a, b, color) {
  const canvas = document.getElementById(canvasId);
  const label = document.getElementById(labelId);
  if (!canvas) return;

  if (label) label.textContent = distributionLabel(dist, a, b);

  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const pad = 14;
  const values = buildDistributionPreview(dist, a, b);
  const barW = (w - 2 * pad) / values.length;

  ctx.clearRect(0, 0, w, h);

  const fill = ctx.createLinearGradient(0, pad, 0, h - pad);
  fill.addColorStop(0, color);
  fill.addColorStop(1, colorToRgba(color, 0.08));
  ctx.fillStyle = fill;

  values.forEach((value, i) => {
    const bh = Math.max(2, value * (h - 2 * pad));
    const x = pad + i * barW + 1;
    const y = h - pad - bh;
    ctx.fillRect(x, y, Math.max(1, barW - 1), bh);
  });

  ctx.strokeStyle = "#bdc1c6";
  ctx.beginPath();
  ctx.moveTo(pad, h - pad);
  ctx.lineTo(w - pad, h - pad);
  ctx.stroke();
}

function updateDistributionPreviews() {
  updateDistributionFieldLabels();
  updateLimiterAlgorithmCopy();
  const getNum = (id) => Number(document.getElementById(id).value);
  drawDistributionPreview(
    "latencyPreview",
    "latencyPreviewLabel",
    document.getElementById("latencyDist").value,
    getNum("latA"),
    getNum("latB"),
    "#5f6368"
  );
  drawDistributionPreview(
    "rlLatencyPreview",
    "rlLatencyPreviewLabel",
    document.getElementById("rlLatencyDist").value,
    getNum("rlLatA"),
    getNum("rlLatB"),
    "#5f6368"
  );
}

const COOKIE_NAME = "rl_sim_state";
const COOKIE_TTL_SEC = 60 * 60 * 24 * 180;
const UI_STATE_VERSION = 7;
const CONTROL_IDS = [
  "durationSec",
  "stepMs",
  "rps",
  "burstiness",
  "maxConcurrent",
  "queueCapacity",
  "maxQueueWaitMs",
  "limiterType",
  "latencyDist",
  "latA",
  "latB",
  "rlLatencyDist",
  "rlLatA",
  "rlLatB"
];

function setCookie(name, value, maxAgeSec) {
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${maxAgeSec}; path=/; SameSite=Lax`;
}

function getCookie(name) {
  const prefix = `${name}=`;
  const parts = document.cookie.split("; ");
  for (const part of parts) {
    if (part.startsWith(prefix)) {
      return decodeURIComponent(part.slice(prefix.length));
    }
  }
  return null;
}

function loadStateFromCookie() {
  const raw = getCookie(COOKIE_NAME);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getUiState() {
  const controls = {};
  for (const id of CONTROL_IDS) {
    const el = document.getElementById(id);
    if (el) controls[id] = el.value;
  }
  return {
    version: UI_STATE_VERSION,
    controls,
    windows: readWindows(),
    visibility: Object.fromEntries(seriesVisibility.entries())
  };
}

function saveStateToCookie() {
  const state = getUiState();
  setCookie(COOKIE_NAME, JSON.stringify(state), COOKIE_TTL_SEC);
}

function applyStateToUi(saved) {
  if (!saved) return;
  if (saved.version !== UI_STATE_VERSION) return;

  if (saved.controls) {
    for (const id of CONTROL_IDS) {
      const el = document.getElementById(id);
      if (el && saved.controls[id] !== undefined) {
        el.value = String(saved.controls[id]);
      }
    }
  }

  if (Array.isArray(saved.windows)) {
    const rows = document.getElementById("windowRows");
    rows.innerHTML = "";
    for (const w of saved.windows) {
      addWindowRow(w.windowMs, w.limit);
    }
    updateWindowRowSummaries();
  }

  if (saved.visibility && typeof saved.visibility === "object") {
    for (const [key, val] of Object.entries(saved.visibility)) {
      seriesVisibility.set(key, Boolean(val));
    }
  }
}

const seriesVisibility = new Map();
const REQUIRED_SERIES = new Set(["arrivals"]);
const DEFAULT_VISIBLE_SERIES = new Set(["arrivals", "accepted", "r429", "queue", "active"]);
const mergedChartState = {
  fullSeries: [],
  fullTimeline: [],
  series: [],
  timeline: [],
  hoverIndex: null
};
const MAX_CHART_POINTS = 1600;

function downsampleChartData(series, timeline) {
  const n = timeline.length;
  if (n <= MAX_CHART_POINTS) return { series, timeline };

  const stride = Math.ceil(n / MAX_CHART_POINTS);
  const indexes = [];
  for (let i = 0; i < n; i += stride) indexes.push(i);
  if (indexes[indexes.length - 1] !== n - 1) indexes.push(n - 1);

  return {
    timeline: indexes.map((idx) => timeline[idx]),
    series: series.map((s) => ({
      ...s,
      values: indexes.map((idx) => s.values[idx])
    }))
  };
}

function setMergedChartDisplay(series, timeline, hoverIndex = null) {
  const display = downsampleChartData(series, timeline);
  mergedChartState.series = display.series;
  mergedChartState.timeline = display.timeline;
  mergedChartState.hoverIndex = hoverIndex;
  drawLineChart("mergedChart", mergedChartState.series, null, "count/rate/util%", hoverIndex);
}

function colorForWindowSeries(i) {
  const colors = ["#7b858f", "#9aa2aa", "#626d77", "#b6bec6"];
  return colors[i % colors.length];
}

function buildMergedSeries(result) {
  const base = [
    { key: "accepted", label: "Accepted/s", color: "#188038", values: result.timeline.map((p) => p.acceptedPerSec), emphasis: true, fill: true },
    { key: "r429", label: "429/s", color: "#d93025", values: result.timeline.map((p) => p.r429PerSec), emphasis: true, fill: true },
    { key: "queue", label: "Queue", color: "#b06000", values: result.timeline.map((p) => p.queued) },
    { key: "active", label: "Active", color: "#1a73e8", values: result.timeline.map((p) => p.active) },
    { key: "arrivals", label: "Arrivals/s", color: "#3c4043", values: result.timeline.map((p) => p.arrivalsPerSec), required: true, emphasis: true },
    { key: "rlPending", label: "Limiter Pending", color: "#59636e", values: result.timeline.map((p) => p.limiterPending) }
  ];
  const windows = result.windowSeries.map((w, i) => ({
    key: `window_${i}`,
    label: `${w.label} util%`,
    color: colorForWindowSeries(i),
    values: w.utilizationPct
  }));
  return [...base, ...windows];
}

function renderSeriesToggles(series) {
  const root = document.getElementById("seriesToggles");
  root.innerHTML = "";

  for (const s of series) {
    if (!seriesVisibility.has(s.key)) seriesVisibility.set(s.key, DEFAULT_VISIBLE_SERIES.has(s.key));
    if (s.required || REQUIRED_SERIES.has(s.key)) seriesVisibility.set(s.key, true);
    const id = `toggle_${s.key}`;
    const wrapper = document.createElement("label");
    if (s.required || REQUIRED_SERIES.has(s.key)) wrapper.classList.add("is-required");
    wrapper.innerHTML = `
      <input id="${id}" type="checkbox" ${seriesVisibility.get(s.key) ? "checked" : ""} ${(s.required || REQUIRED_SERIES.has(s.key)) ? "disabled" : ""} />
      <span>${s.label}</span>
    `;
    wrapper.style.setProperty("--legend-color", s.color);
    wrapper.querySelector("input").addEventListener("change", (e) => {
      if (s.required || REQUIRED_SERIES.has(s.key)) return;
      seriesVisibility.set(s.key, e.target.checked);
      const visible = series.filter((x) => x.required || REQUIRED_SERIES.has(x.key) || seriesVisibility.get(x.key));
      setMergedChartDisplay(
        visible.length ? visible : [series[0]],
        mergedChartState.fullTimeline,
        mergedChartState.hoverIndex
      );
      saveStateToCookie();
    });
    root.appendChild(wrapper);
  }
}

function formatChartValue(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString() : "0";
}

function renderMergedChartTooltip(evt) {
  const canvas = document.getElementById("mergedChart");
  const tooltip = document.getElementById("chartTooltip");
  if (!canvas || !tooltip || !mergedChartState.series.length || !mergedChartState.timeline.length) return;

  const rect = canvas.getBoundingClientRect();
  const pad = 48;
  const scaleX = canvas.width / rect.width;
  const xCanvas = (evt.clientX - rect.left) * scaleX;
  const n = mergedChartState.series[0].values.length;
  const innerW = canvas.width - 2 * pad;
  const idx = clamp(Math.round(((xCanvas - pad) / innerW) * Math.max(1, n - 1)), 0, n - 1);
  const timelinePoint = mergedChartState.timeline[idx];

  mergedChartState.hoverIndex = idx;
  drawLineChart("mergedChart", mergedChartState.series, null, "count/rate/util%", idx);

  tooltip.innerHTML = [
    `<strong>${timelinePoint ? timelinePoint.tSec.toFixed(1) : idx}s</strong>`,
    ...mergedChartState.series.map((s) => (
      `<div><span>${s.label}</span><b>${formatChartValue(s.values[idx])}</b></div>`
    ))
  ].join("");
  tooltip.hidden = false;

  const frame = tooltip.parentElement.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const left = Math.min(evt.clientX - frame.left + 14, frame.width - tooltipRect.width - 8);
  const top = Math.max(8, evt.clientY - frame.top - 18);
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${top}px`;
}

function hideMergedChartTooltip() {
  const tooltip = document.getElementById("chartTooltip");
  if (tooltip) tooltip.hidden = true;
  mergedChartState.hoverIndex = null;
  if (mergedChartState.series.length) {
    drawLineChart("mergedChart", mergedChartState.series, null, "count/rate/util%");
  }
}

function setChecklistItem(id, state, text) {
  const item = document.getElementById(id);
  if (!item) return;
  item.dataset.state = state;
  item.textContent = text;
}

function markConfigChanged() {
}

function markResultsCurrent() {
}

function scrollToResults() {
  document.getElementById("resultPanel")?.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

function createNumberField({ label, className, min, step, value, unit }) {
  const wrapper = document.createElement("label");
  const labelText = document.createElement("span");
  const input = document.createElement("input");
  const unitText = document.createElement("span");

  labelText.textContent = label;
  input.type = "number";
  input.className = className;
  input.min = min;
  input.step = step;
  input.value = value;
  unitText.className = "field-unit";
  unitText.textContent = unit;

  wrapper.append(labelText, input, unitText);
  return { wrapper, input };
}

function formatWindowSeconds(windowMs) {
  const seconds = windowMs / 1000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function updateWindowRowSummaries() {
  const rows = document.querySelectorAll(".window-row");
  const empty = document.getElementById("windowEmpty");
  if (empty) empty.hidden = rows.length > 0;

  rows.forEach((row, idx) => {
    const seconds = Number(row.querySelector(".win-sec").value);
    const limit = Number(row.querySelector(".win-limit").value);
    const algorithm = document.getElementById("limiterType").value === "sliding"
      ? "Sliding window"
      : "Fixed window";
    row.querySelector(".window-rule-title").textContent = `Rule ${idx + 1}`;
    row.querySelector(".window-rule-summary").textContent = `Allow up to ${formatNum(limit)} requests every ${formatWindowSeconds(seconds * 1000)}s`;
    row.querySelector(".window-algorithm").textContent = algorithm;
  });
}

function addWindowRow(windowMs, limit) {
  const row = document.createElement("div");
  row.className = "window-row";
  const windowSec = windowMs / 1000;

  const header = document.createElement("div");
  header.className = "window-rule-header";

  const titleGroup = document.createElement("div");
  const title = document.createElement("strong");
  const summary = document.createElement("span");
  title.className = "window-rule-title";
  summary.className = "window-rule-summary";
  titleGroup.append(title, summary);

  const algorithm = document.createElement("span");
  algorithm.className = "window-algorithm";

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "remove-window";
  removeButton.textContent = "Remove";

  header.append(titleGroup, algorithm);

  const windowField = createNumberField({
    label: "Window",
    className: "win-sec",
    min: "0.001",
    step: "0.5",
    value: windowSec,
    unit: "seconds"
  });
  const limitField = createNumberField({
    label: "Limit",
    className: "win-limit",
    min: "1",
    step: "1",
    value: limit,
    unit: "requests"
  });

  row.append(header, windowField.wrapper, limitField.wrapper, removeButton);

  removeButton.addEventListener("click", () => {
    row.remove();
    updateWindowRowSummaries();
    saveStateToCookie();
    markConfigChanged();
  });

  const handleInput = () => {
    updateWindowRowSummaries();
    saveStateToCookie();
    markConfigChanged();
  };
  windowField.input.addEventListener("input", handleInput);
  limitField.input.addEventListener("input", handleInput);

  document.getElementById("windowRows").appendChild(row);
  updateWindowRowSummaries();
}

function readWindows() {
  const rows = Array.from(document.querySelectorAll(".window-row"));
  const windows = rows.map((row) => ({
    windowMs: clamp(Number(row.querySelector(".win-sec").value) * 1000, 1, 3600000),
    limit: clamp(Number(row.querySelector(".win-limit").value), 1, 10000000)
  }));
  const valid = windows.filter((w) => Number.isFinite(w.windowMs) && Number.isFinite(w.limit) && w.windowMs > 0 && w.limit > 0);
  return valid;
}

function readConfig() {
  const getNum = (id) => Number(document.getElementById(id).value);
  return {
    durationSec: clamp(getNum("durationSec"), 1, 3600),
    stepMs: clamp(getNum("stepMs"), 1, 2000),
    rps: clamp(getNum("rps"), 0, 200000),
    burstiness: clamp(getNum("burstiness"), 0, 1),
    maxConcurrent: clamp(getNum("maxConcurrent"), 1, 100000),
    queueCapacity: clamp(getNum("queueCapacity"), 0, 1000000),
    maxQueueWaitMs: clamp(getNum("maxQueueWaitMs"), 0, 600000),
    limiterType: document.getElementById("limiterType").value,
    windows: readWindows(),
    rlLatencyDist: document.getElementById("rlLatencyDist").value,
    rlLatA: getNum("rlLatA"),
    rlLatB: getNum("rlLatB"),
    latencyDist: document.getElementById("latencyDist").value,
    latA: getNum("latA"),
    latB: getNum("latB")
  };
}

function runAndRender(options = {}) {
  const cfg = readConfig();
  const result = runSimulation(cfg);
  renderKpis(result);
  updateDistributionPreviews();

  const merged = buildMergedSeries(result);
  renderSeriesToggles(merged);
  const visible = merged.filter((s) => s.required || REQUIRED_SERIES.has(s.key) || seriesVisibility.get(s.key));
  mergedChartState.fullSeries = merged;
  mergedChartState.fullTimeline = result.timeline;
  setMergedChartDisplay(visible.length ? visible : [merged[0]], result.timeline);
  drawLatencyHistogram(result.latency.samples);
  saveStateToCookie();
  markResultsCurrent();
  if (options.scrollToResults) scrollToResults();
}

function boot() {
  const mergedChart = document.getElementById("mergedChart");
  mergedChart.addEventListener("mousemove", renderMergedChartTooltip);
  mergedChart.addEventListener("mouseleave", hideMergedChartTooltip);
  document.getElementById("addWindowBtn").addEventListener("click", () => {
    addWindowRow(1000, 85);
    saveStateToCookie();
    markConfigChanged();
  });
  document.getElementById("runBtn").addEventListener("click", () => runAndRender({ scrollToResults: true }));
  for (const id of CONTROL_IDS) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", () => {
      saveStateToCookie();
      updateDistributionPreviews();
      markConfigChanged();
    });
    if (el) el.addEventListener("change", () => {
      saveStateToCookie();
      updateDistributionPreviews();
      markConfigChanged();
    });
  }

  addWindowRow(1000, 85);
  applyStateToUi(loadStateFromCookie());
  runAndRender();
}

boot();
