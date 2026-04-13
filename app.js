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
    { name: "Most Blocking Window", value: mostBlocked ? `${mostBlocked.label} (${formatNum(mostBlocked.blocked)})` : "-", kind: "queue" },
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

function drawAxes(ctx, w, h, pad, maxY, maxXLabel, yLabel) {
  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, "#ffffff");
  bg.addColorStop(1, "#fbfcfd");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "#e4eaf0";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i += 1) {
    const y = pad + (i * innerH) / 5;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();

    const value = maxY - (i * maxY) / 5;
    ctx.fillStyle = "#5f6b76";
    ctx.font = "12px Inter, Segoe UI, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(String(Math.round(value)), pad - 10, y + 4);
  }

  for (let i = 0; i <= 6; i += 1) {
    const x = pad + (i * innerW) / 6;
    ctx.beginPath();
    ctx.moveTo(x, pad);
    ctx.lineTo(x, h - pad);
    ctx.stroke();
  }

  ctx.strokeStyle = "#b8c4cf";
  ctx.beginPath();
  ctx.moveTo(pad, pad);
  ctx.lineTo(pad, h - pad);
  ctx.lineTo(w - pad, h - pad);
  ctx.stroke();

  ctx.fillStyle = "#64717d";
  ctx.font = "12px Inter, Segoe UI, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(maxXLabel, w - pad - 46, h - 8);
  if (yLabel) ctx.fillText(yLabel, 8, 12);
}

function drawLineChart(canvasId, series, maxYOverride, yLabel, hoverIndex = null) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const pad = 48;
  const n = series.length ? series[0].values.length : 0;

  ctx.clearRect(0, 0, w, h);

  const maxY = maxYOverride || Math.max(1, ...series.flatMap((s) => s.values));
  drawAxes(ctx, w, h, pad, maxY, "time", yLabel);

  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;
  const toX = (i) => pad + (i / Math.max(1, n - 1)) * innerW;
  const toY = (v) => pad + innerH - (v / maxY) * innerH;

  for (const s of series) {
    const points = s.values.map((v, i) => ({ x: toX(i), y: toY(v) }));
    if (!points.length) continue;

    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
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

function drawLatencyHistogram(samples) {
  const canvas = document.getElementById("latencyChart");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const pad = 48;

  ctx.clearRect(0, 0, w, h);

  const { bins, max } = histogram(samples, 32);
  drawAxes(ctx, w, h, pad, max, "latency", "count");

  if (!bins.length) return;

  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;
  const barW = innerW / bins.length;

  const fill = ctx.createLinearGradient(0, pad, 0, h - pad);
  fill.addColorStop(0, "#147a55");
  fill.addColorStop(1, "#9bd1bf");
  ctx.fillStyle = fill;
  bins.forEach((b, i) => {
    const x = pad + i * barW + 2;
    const bh = (b.count / max) * innerH;
    const y = pad + innerH - bh;
    ctx.fillRect(x, y, Math.max(1, barW - 4), bh);
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

const HELP_COPY = {
  durationSec: {
    title: "Duration",
    body: "How long the simulation runs. Longer duration gives a more stable picture, but it can make the run heavier.",
    visual: ["short run", "60s model", "long run"]
  },
  stepMs: {
    title: "Step",
    body: "The simulation tick size. 1 ms is supported for fine runs. Larger steps are faster but less detailed.",
    visual: ["1ms", "100ms", "1000ms"]
  },
  rps: {
    title: "Target RPS",
    body: "Average incoming request rate before burst shaping. This is the traffic pressure applied to the limiter.",
    visual: ["requests", "per", "second"]
  },
  burstiness: {
    title: "Burst factor",
    body: "How wavy the traffic is. 0 is steady traffic. 1 creates stronger peaks and quiet periods.",
    visual: ["steady", "wave", "burst"]
  },
  maxConcurrent: {
    title: "Max concurrent",
    body: "Maximum requests the service can process at the same time. When this is full, accepted requests wait in the queue.",
    visual: ["workers", "in flight", "full"]
  },
  queueCapacity: {
    title: "Queue capacity",
    body: "Maximum accepted requests that can wait for service. If the queue is full, new accepted requests are counted as 429.",
    visual: ["service full", "queue slots", "429"]
  },
  maxQueueWaitMs: {
    title: "Max queue wait",
    body: "Maximum time a request can sit in the queue. If it waits longer than this, it times out and becomes a 429.",
    visual: ["queued", "wait limit", "timeout"]
  },
  limiterType: {
    title: "Window algorithm",
    body: "This is the counter type applied to every cascaded window row. Fixed resets at boundaries. Sliding counts the last N seconds.",
    visual: ["fixed reset", "or", "rolling"]
  },
  latencyDist: {
    title: "Service distribution",
    body: "Shape used to sample backend service latency. The chart below previews the shape before you run the simulation.",
    visual: ["shape", "sample", "latency"]
  },
  rlLatencyDist: {
    title: "Decision distribution",
    body: "Shape used to sample rate-limiter decision latency. This models time spent deciding allow or reject.",
    visual: ["decide", "delay", "impact"]
  },
  winSec: {
    title: "Window length",
    body: "How many seconds this limiter rule watches. Example: 10 seconds with limit 500 means up to 500 requests in that 10s window.",
    visual: ["1s", "10s", "60s"]
  },
  winLimit: {
    title: "Request limit",
    body: "Maximum requests allowed inside this row's window. A request must pass every cascaded row to be accepted.",
    visual: ["limit", "pass all", "or 429"]
  }
};

function fieldKeyForHelp(control) {
  if (control.id) return control.id;
  if (control.classList.contains("win-sec")) return "winSec";
  if (control.classList.contains("win-limit")) return "winLimit";
  return "";
}

function parameterHelp(control) {
  const id = control.id;
  if (!["latA", "latB", "rlLatA", "rlLatB"].includes(id)) return null;
  const isLimiter = id.startsWith("rl");
  const dist = document.getElementById(isLimiter ? "rlLatencyDist" : "latencyDist").value;
  const copy = distributionFieldCopy(dist, isLimiter ? "Decision" : "");
  const isA = id.endsWith("A");
  const title = isA ? copy.aLabel : copy.bLabel;
  const body = isA
    ? `This is the first value used by the selected ${dist} distribution: ${copy.aHelp}.`
    : `This is the second value used by the selected ${dist} distribution: ${copy.bHelp}.`;
  return { title, body, visual: ["distribution", isA ? "A" : "B", "shape"] };
}

function helpForControl(control) {
  return parameterHelp(control) || HELP_COPY[fieldKeyForHelp(control)];
}

function helpPopover() {
  let popover = document.getElementById("helpPopover");
  if (!popover) {
    popover = document.createElement("div");
    popover.id = "helpPopover";
    popover.className = "help-popover";
    popover.hidden = true;
    document.body.appendChild(popover);
  }
  return popover;
}

function renderHelpPopover(trigger, control) {
  const help = helpForControl(control);
  if (!help) return;
  const popover = helpPopover();
  popover.innerHTML = `
    <strong>${help.title}</strong>
    <p>${help.body}</p>
    <div class="help-visual">${help.visual.map((item) => `<span>${item}</span>`).join("")}</div>
  `;
  popover.hidden = false;

  const rect = trigger.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const left = Math.min(window.innerWidth - popoverRect.width - 12, rect.left);
  const top = Math.min(window.innerHeight - popoverRect.height - 12, rect.bottom + 8);
  popover.style.left = `${Math.max(12, left)}px`;
  popover.style.top = `${Math.max(12, top)}px`;
}

function hideHelpPopover() {
  const popover = document.getElementById("helpPopover");
  if (popover) popover.hidden = true;
}

function enhanceHelpButtons(root = document) {
  root.querySelectorAll("label").forEach((label) => {
    if (label.querySelector(".help-trigger")) return;
    const control = label.querySelector("input, select");
    const title = label.querySelector("span:first-child");
    if (!control || !title || !helpForControl(control)) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "help-trigger";
    button.setAttribute("aria-label", `Explain ${title.textContent}`);
    button.textContent = "?";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      renderHelpPopover(button, control);
    });
    label.appendChild(button);
  });
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
  document.querySelectorAll(".window-algorithm").forEach((el) => {
    el.textContent = type === "sliding" ? "Sliding rolling window" : "Fixed window counter";
  });
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
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "#e4eaf0";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i += 1) {
    const y = pad + (i * (h - 2 * pad)) / 3;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  }

  const fill = ctx.createLinearGradient(0, pad, 0, h - pad);
  fill.addColorStop(0, color);
  fill.addColorStop(1, colorToRgba(color, 0.18));
  ctx.fillStyle = fill;

  values.forEach((value, i) => {
    const bh = Math.max(2, value * (h - 2 * pad));
    const x = pad + i * barW + 1;
    const y = h - pad - bh;
    ctx.fillRect(x, y, Math.max(1, barW - 2), bh);
  });

  ctx.strokeStyle = "#b8c4cf";
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
    "#1d5f99"
  );
  drawDistributionPreview(
    "rlLatencyPreview",
    "rlLatencyPreviewLabel",
    document.getElementById("rlLatencyDist").value,
    getNum("rlLatA"),
    getNum("rlLatB"),
    "#147a55"
  );
}

const COOKIE_NAME = "rl_sim_state";
const COOKIE_TTL_SEC = 60 * 60 * 24 * 180;
const UI_STATE_VERSION = 3;
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

  if (saved.controls) {
    for (const id of CONTROL_IDS) {
      const el = document.getElementById(id);
      if (el && saved.controls[id] !== undefined) {
        if (id === "latencyDist" && saved.version !== UI_STATE_VERSION && saved.controls[id] === "constant") {
          continue;
        }
        el.value = String(saved.controls[id]);
      }
    }
  }

  if (saved.windows && Array.isArray(saved.windows) && saved.windows.length > 0) {
    const rows = document.getElementById("windowRows");
    rows.innerHTML = "";
    for (const w of saved.windows) {
      addWindowRow(w.windowMs, w.limit);
    }
  }

  if (saved.version === UI_STATE_VERSION && saved.visibility && typeof saved.visibility === "object") {
    for (const [key, val] of Object.entries(saved.visibility)) {
      seriesVisibility.set(key, Boolean(val));
    }
  }
}

const seriesVisibility = new Map();
const DEFAULT_VISIBLE_SERIES = new Set(["active", "queue", "accepted", "r429"]);
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
  const colors = ["#7b8794", "#9aa5b1", "#52606d", "#b8c4cf"];
  return colors[i % colors.length];
}

function buildMergedSeries(result) {
  const base = [
    { key: "accepted", label: "Accepted/s", color: "#147a55", values: result.timeline.map((p) => p.acceptedPerSec) },
    { key: "r429", label: "429/s", color: "#b42318", values: result.timeline.map((p) => p.r429PerSec) },
    { key: "queue", label: "Queue", color: "#8a5b12", values: result.timeline.map((p) => p.queued) },
    { key: "active", label: "Active", color: "#1d5f99", values: result.timeline.map((p) => p.active) },
    { key: "arrivals", label: "Arrivals/s", color: "#5f6b76", values: result.timeline.map((p) => p.arrivalsPerSec) },
    { key: "rlPending", label: "Limiter Pending", color: "#167481", values: result.timeline.map((p) => p.limiterPending) }
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
    const id = `toggle_${s.key}`;
    const wrapper = document.createElement("label");
    wrapper.innerHTML = `
      <input id="${id}" type="checkbox" ${seriesVisibility.get(s.key) ? "checked" : ""} />
      <span>${s.label}</span>
    `;
    wrapper.style.setProperty("--legend-color", s.color);
    wrapper.querySelector("input").addEventListener("change", (e) => {
      seriesVisibility.set(s.key, e.target.checked);
      const visible = series.filter((x) => seriesVisibility.get(x.key));
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
  setChecklistItem("checkInputs", "dirty", "Inputs changed");
  setChecklistItem("checkResults", "dirty", "Results need update");
}

function markResultsCurrent() {
  setChecklistItem("checkInputs", "ok", "Inputs captured");
  setChecklistItem("checkResults", "ok", "Results current");
}

function scrollToResults() {
  document.getElementById("resultPanel")?.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

function addWindowRow(windowMs, limit) {
  const row = document.createElement("div");
  row.className = "window-row";
  const windowSec = windowMs / 1000;
  row.innerHTML = `
    <div class="window-algorithm"></div>
    <label><span>Window length</span>
      <input type="number" class="win-sec" min="0.001" step="0.5" value="${windowSec}" />
      <span class="field-unit">seconds</span>
    </label>
    <label><span>Request limit</span>
      <input type="number" class="win-limit" min="1" step="1" value="${limit}" />
      <span class="field-unit">requests per window</span>
    </label>
    <button type="button" class="remove-window">Remove</button>
  `;
  row.querySelector(".window-algorithm").textContent = document.getElementById("limiterType").value === "sliding"
    ? "Sliding rolling window"
    : "Fixed window counter";
  row.querySelector(".remove-window").addEventListener("click", () => {
    row.remove();
    saveStateToCookie();
    markConfigChanged();
  });
  row.querySelector(".win-sec").addEventListener("input", () => {
    saveStateToCookie();
    markConfigChanged();
  });
  row.querySelector(".win-limit").addEventListener("input", () => {
    saveStateToCookie();
    markConfigChanged();
  });
  document.getElementById("windowRows").appendChild(row);
  enhanceHelpButtons(row);
}

function readWindows() {
  const rows = Array.from(document.querySelectorAll(".window-row"));
  const windows = rows.map((row) => ({
    windowMs: clamp(Number(row.querySelector(".win-sec").value) * 1000, 1, 3600000),
    limit: clamp(Number(row.querySelector(".win-limit").value), 1, 10000000)
  }));
  const valid = windows.filter((w) => Number.isFinite(w.windowMs) && Number.isFinite(w.limit) && w.windowMs > 0 && w.limit > 0);
  return valid.length ? valid : [{ windowMs: 1000, limit: 50 }];
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
  const visible = merged.filter((s) => seriesVisibility.get(s.key));
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
  document.addEventListener("click", hideHelpPopover);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideHelpPopover();
  });

  document.getElementById("addWindowBtn").addEventListener("click", () => {
    addWindowRow(1000, 60);
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

  addWindowRow(1000, 60);
  addWindowRow(10000, 500);
  addWindowRow(60000, 2000);
  applyStateToUi(loadStateFromCookie());
  runAndRender();
  enhanceHelpButtons();
}

boot();
