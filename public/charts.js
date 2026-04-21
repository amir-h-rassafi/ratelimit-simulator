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
    ctx.strokeStyle = "#dadce0";
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
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
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    }
  }
}

function nextLatencyAxisMax(value) {
  const safe = Math.max(10, value);
  const exponent = Math.ceil(Math.log10(safe));
  return 10 ** exponent;
}

function latencyTickValues(max) {
  const ticks = [0];
  for (let value = 10; value <= max; value *= 10) ticks.push(value);
  return ticks;
}

function histogram(values, binCount) {
  if (!values.length) return { bins: [], max: 1, domainMax: 10 };
  const min = 0;
  const max = nextLatencyAxisMax(values[values.length - 1]);
  const width = Math.max(1, max / binCount);
  const bins = Array.from({ length: binCount }, (_, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    count: 0
  }));

  for (const v of values) {
    const idx = clamp(Math.floor((v - min) / width), 0, binCount - 1);
    bins[idx].count += 1;
  }

  return { bins, max: Math.max(1, ...bins.map((b) => b.count)), domainMax: max };
}

function drawLatencyAxis(ctx, w, h, pad, bins, maxCount, domainMax) {
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

  const max = Math.max(10, domainMax || bins[bins.length - 1].to);
  const ticks = latencyTickValues(max);
  let lastRight = -Infinity;
  for (const value of ticks) {
    const x = pad + (value / max) * innerW;
    const label = String(value);
    const width = ctx.measureText(label).width;
    const left = x - width / 2;
    const right = x + width / 2;
    if (left <= lastRight + 8 && value !== 0 && value !== max) continue;
    ctx.textAlign = value === 0 ? "left" : value === max ? "right" : "center";
    ctx.fillText(label, x, h - pad + 22);
    lastRight = right;
  }

  return maxY;
}

function drawLatencyHistogram(series) {
  const canvas = document.getElementById("latencyChart");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const pad = 56;

  ctx.clearRect(0, 0, w, h);

  const activeSeries = (series || []).filter((s) => s && s.samples && s.samples.length);
  const allSamples = activeSeries.flatMap((s) => s.samples).sort((a, b) => a - b);
  const baseHist = histogram(allSamples, 32);
  const maxY = drawLatencyAxis(ctx, w, h, pad, baseHist.bins, baseHist.max, baseHist.domainMax);
  if (!baseHist.bins.length) return;

  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;
  const min = 0;
  const max = baseHist.domainMax || baseHist.bins[baseHist.bins.length - 1].to;
  const width = Math.max(1, (max - min) / 32);
  const binW = innerW / 32;
  const seriesCount = activeSeries.length;

  activeSeries.forEach((s, sIdx) => {
    const bins = Array.from({ length: 32 }, (_, i) => ({ from: min + i * width, to: min + (i + 1) * width, count: 0 }));
    for (const value of s.samples) {
      const idx = clamp(Math.floor((value - min) / width), 0, bins.length - 1);
      bins[idx].count += 1;
    }
    bins.forEach((b, i) => {
      const subW = Math.max(2, (binW - 6) / Math.max(1, seriesCount));
      const x = pad + i * binW + 3 + sIdx * subW;
      const bh = b.count > 0 ? Math.max(1.5, (b.count / maxY) * innerH) : 0;
      const y = pad + innerH - bh;
      ctx.fillStyle = colorToRgba(s.color, s.key === "overall" ? 0.28 : 0.72);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.key === "overall" ? 1.5 : 1;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, subW - 1, bh, 2);
        ctx.fill();
        if (s.key === "overall") ctx.stroke();
      } else {
        ctx.fillRect(x, y, subW - 1, bh);
      }
    });
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

function drawSparkline(canvasId, values, color = "#5f6368") {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !values.length) return;

  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const pad = 10;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1e-7, max - min);
  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;
  const points = values.map((value, i) => ({
    x: pad + (i / Math.max(1, values.length - 1)) * innerW,
    y: pad + innerH - ((value - min) / span) * innerH
  }));

  ctx.clearRect(0, 0, w, h);

  const fill = ctx.createLinearGradient(0, pad, 0, h - pad);
  fill.addColorStop(0, colorToRgba(color, 0.18));
  fill.addColorStop(1, colorToRgba(color, 0));
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(points[0].x, h - pad);
  points.forEach((point) => ctx.lineTo(point.x, point.y));
  ctx.lineTo(points[points.length - 1].x, h - pad);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  points.forEach((point, i) => {
    if (i === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();

  ctx.strokeStyle = "#bdc1c6";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, h - pad);
  ctx.lineTo(w - pad, h - pad);
  ctx.stroke();
}

function buildTrafficPreview(durationSec, rps, burstiness, trafficNoise = false) {
  const count = 64;
  const steps = Math.max(1, count - 1);
  return Array.from({ length: count }, (_, i) => {
    const expected = expectedTrafficRpsAt(i, steps, rps, burstiness);
    if (!trafficNoise) return expected;
    const wave = Math.sin((i + 1) * 12.9898) * 43758.5453;
    const frac = wave - Math.floor(wave);
    const centered = (frac - 0.5) * 0.35;
    return Math.max(0, expected * (1 + centered));
  });
}

function trafficPreviewLabel(durationSec, rps, burstiness, trafficNoise = false) {
  const suffix = trafficNoise ? " with random noise enabled" : " with deterministic arrivals";
  if (burstiness <= 0) return `Expected offered traffic: flat at ${Math.round(rps)} rps over ${Math.round(durationSec)}s${suffix}`;
  return `Expected offered traffic: ${Math.round(rps)} rps baseline with a ${Math.round(burstiness * 100)}% burst wave over ${Math.round(durationSec)}s${suffix}`;
}

function buildLimiterPreview(windows) {
  const rules = [...windows].sort((a, b) => a.windowMs - b.windowMs);
  if (!rules.length) return [{ start: 0, end: 1, value: 0.12 }];
  const rates = rules.map((w) => w.limit / Math.max(0.001, w.windowMs / 1000));
  const maxRate = Math.max(1e-7, ...rates);
  return rules.map((w, idx) => ({
    start: idx / rules.length,
    end: (idx + 1) / rules.length,
    value: (w.limit / Math.max(0.001, w.windowMs / 1000)) / maxRate
  }));
}

function drawLimiterWindowPreview(canvasId, windows, type, color = "#d93025") {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const pad = 10;
  const segments = buildLimiterPreview(windows);
  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;

  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#bdc1c6";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, h - pad);
  ctx.lineTo(w - pad, h - pad);
  ctx.stroke();

  segments.forEach((segment, idx) => {
    const x = pad + segment.start * innerW;
    const width = Math.max(2, (segment.end - segment.start) * innerW - 3);
    const barH = Math.max(3, segment.value * innerH);
    const y = pad + innerH - barH;
    ctx.fillStyle = colorToRgba(color, type === "sliding" ? 0.32 : 0.68);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    if (type === "fixed") {
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, width, barH, 2);
        ctx.fill();
      } else {
        ctx.fillRect(x, y, width, barH);
      }
    } else {
      ctx.beginPath();
      ctx.moveTo(x, h - pad);
      ctx.lineTo(x, y + 4);
      ctx.quadraticCurveTo(x + width * 0.5, y - 2, x + width, y + 4);
      ctx.lineTo(x + width, h - pad);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, y + 4);
      ctx.quadraticCurveTo(x + width * 0.5, y - 2, x + width, y + 4);
      ctx.stroke();
    }
    if (idx < segments.length - 1) {
      const splitX = pad + segment.end * innerW;
      ctx.strokeStyle = "#e5e8eb";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(splitX, pad + 2);
      ctx.lineTo(splitX, h - pad);
      ctx.stroke();
    }
  });
}

function limiterPreviewLabel(windows, type) {
  if (!windows.length) return "No rules configured";
  const rules = [...windows].sort((a, b) => a.windowMs - b.windowMs).slice(0, 3);
  const summary = rules.map((w) => `${Math.round(w.limit)} / ${Math.round(w.windowMs / 1000)}s`).join(" • ");
  const label = type === "sliding" ? "Sliding" : "Fixed";
  return `${label}: ${summary}`;
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

function drawDistributionPreview(canvasId, labelId, dist, a, b, color) {
  const label = document.getElementById(labelId);
  if (label) label.textContent = distributionLabel(dist, a, b);
  drawSparkline(canvasId, buildDistributionPreview(dist, a, b), color);
}
