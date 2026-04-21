function formatNum(n) {
  return Number.isFinite(n) ? n.toLocaleString() : "0";
}

function formatMs(v) {
  return `${Math.round(v)} ms`;
}

function buildProtectionSummary(result, baseline) {
  const base = baseline || result;
  const avoided503 = Math.max(0, base.totals.rate503 - result.totals.rate503);
  const avoidedAppLoad = Math.max(0, base.totals.enteredApp - result.totals.enteredApp);
  const avoidedDependencyLoad = Math.max(0, base.totals.enteredDependency - result.totals.enteredDependency);
  const avoidedDepQueue = Math.max(0, base.queues.peakDepQueue - result.queues.peakDepQueue);
  const failureReductionPct = base.totals.rate503 > 0 ? (100 * avoided503) / base.totals.rate503 : 0;
  return {
    avoided503,
    avoidedAppLoad,
    avoidedDependencyLoad,
    avoidedDepQueue,
    failureReductionPct
  };
}

function renderKpis(result, baseline) {
  const { totals, latency, limiterLatency, windowSeries } = result;
  const protection = buildProtectionSummary(result, baseline);
  const mostBlocked = windowSeries
    .map((w) => ({ label: w.label, blocked: w.blocked }))
    .sort((a, b) => b.blocked - a.blocked)[0];

  const items = [
    { name: "Arrived", value: formatNum(totals.arrived), kind: "neutral" },
    { name: "Served", value: `${formatNum(totals.served)} (${totals.servedPct.toFixed(1)}%)`, kind: "served" },
    { name: "Blocked by Limiter", value: `${formatNum(totals.rate429)} (${totals.rate429Pct.toFixed(1)}%)`, kind: "danger" },
    { name: "503 Unavailable", value: `${formatNum(totals.rate503)} (${totals.rate503Pct.toFixed(1)}%)`, kind: "danger" },
    { name: "503 Avoided", value: formatNum(protection.avoided503), kind: "served" },
    { name: "Dependency Load Avoided", value: formatNum(protection.avoidedDependencyLoad), kind: "served" },
    { name: "Failure Reduction", value: `${protection.failureReductionPct.toFixed(1)}%`, kind: "served" },
    { name: "App Pending Peak", value: formatNum(result.queues.peakAppQueue), kind: "queue" },
    { name: "Dependency Pending Peak", value: formatNum(result.queues.peakDepQueue), kind: "queue" },
    { name: "Dependency Pending Avoided", value: formatNum(protection.avoidedDepQueue), kind: "queue" },
    { name: "Limiter Rule", value: mostBlocked ? `${mostBlocked.label} (${formatNum(mostBlocked.blocked)})` : "No rules", kind: "queue" },
    { name: "Latency p95", value: formatMs(latency.p95), kind: "latency" },
    { name: "Avg Queue Delay", value: formatMs(latency.avgQueueDelay), kind: "queue" },
    { name: "Limiter Lat p95", value: formatMs(limiterLatency.p95), kind: "latency" }
  ];

  const kpiRoot = document.getElementById("kpis");
  kpiRoot.innerHTML = items.map(({ name, value, kind }) => (
    `<div class="kpi" data-kind="${kind}"><div class="name">${name}</div><div class="value">${value}</div></div>`
  )).join("");
}


function renderLatencyStats(result) {
  const root = document.getElementById("latencyStats");
  if (!root) return;
  const samples = result.latency.samples;
  const min = samples.length ? samples[0] : 0;
  const max = samples.length ? samples[samples.length - 1] : 0;
  const statusItems = [
    { code: "200", label: "served", value: formatNum(result.totals.served), kind: "ok" },
    { code: "429", label: "rate limited", value: formatNum(result.totals.rate429), kind: "warn" },
    { code: "503", label: "unavailable", value: formatNum(result.totals.rate503), kind: "bad" }
  ];
  const distItems = [
    { name: "HTTP 200 samples", value: formatNum(samples.length) },
    { name: "Min", value: formatMs(min) },
    { name: "p50", value: formatMs(result.latency.p50) },
    { name: "p95", value: formatMs(result.latency.p95) },
    { name: "p99", value: formatMs(result.latency.p99) },
    { name: "Max", value: formatMs(max) }
  ];
  root.innerHTML = `
    <div class="status-stats">
      ${statusItems.map(({ code, label, value, kind }) => (`<div class="status-stat ${kind}"><span>${code}</span><strong>${value}</strong><small>${label}</small></div>`)).join("")}
    </div>
    <div class="dist-stats-grid">
      ${distItems.map(({ name, value }) => (`<div class="dist-stat"><span>${name}</span><strong>${value}</strong></div>`)).join("")}
    </div>
  `;
}
