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
    { name: "429 Rate Limited", value: `${formatNum(totals.rate429)} (${totals.rate429Pct.toFixed(1)}%)`, kind: "danger" },
    { name: "503 Unavailable", value: `${formatNum(totals.rate503)} (${totals.rate503Pct.toFixed(1)}%)`, kind: "danger" },
    { name: "Queue Timeout 503", value: formatNum(totals.droppedWait), kind: "danger" },
    { name: "Queue Full 503", value: formatNum(totals.droppedFull), kind: "danger" },
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

function updateDistributionPreviews() {
  updateDistributionFieldLabels();
  updateLimiterAlgorithmCopy();
  const getNum = (id) => Number(document.getElementById(id).value);
  const durationSec = getNum("durationSec");
  const rps = getNum("rps");
  const burstiness = getNum("burstiness");
  setText("trafficPreviewLabel", trafficPreviewLabel(durationSec, rps, burstiness));
  drawSparkline("trafficPreview", buildTrafficPreview(durationSec, rps, burstiness), "#1a73e8");
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
const UI_STATE_VERSION = 8;
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
const DEFAULT_VISIBLE_SERIES = new Set(["arrivals", "accepted", "r429", "r503", "queue", "active"]);
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
    { key: "r503", label: "503/s", color: "#a142f4", values: result.timeline.map((p) => p.r503PerSec), emphasis: true },
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

  tooltip.innerHTML = `
    <span class="tooltip-time">${timelinePoint ? timelinePoint.tSec.toFixed(1) : idx}s</span>
    ${mergedChartState.series.map((s) => (
      `<span class="tooltip-chip" style="--chip-color:${s.color}">
        ${s.label}: <b>${formatChartValue(s.values[idx])}</b>
      </span>`
    )).join("")}
  `;
  tooltip.hidden = false;

  const frame = tooltip.parentElement.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const left = evt.clientX - frame.left - tooltipRect.width / 2;
  const top = 8;
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
  document.getElementById("mainChartPanel")?.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
  window.setTimeout(() => {
    document.getElementById("mergedChart")?.focus({ preventScroll: true });
  }, 350);
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
  return windows.filter((w) => Number.isFinite(w.windowMs) && Number.isFinite(w.limit) && w.windowMs > 0 && w.limit > 0);
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
