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

  const depCopy = distributionFieldCopy(document.getElementById("depLatencyDist").value);
  setText("depLatALabel", depCopy.aLabel);
  setText("depLatAHelp", depCopy.aHelp);
  setText("depLatBLabel", depCopy.bLabel);
  setText("depLatBHelp", depCopy.bHelp);

  const rlCopy = distributionFieldCopy(document.getElementById("rlLatencyDist").value, "Decision");
  setText("rlLatALabel", rlCopy.aLabel);
  setText("rlLatAHelp", rlCopy.aHelp);
  setText("rlLatBLabel", rlCopy.bLabel);
  setText("rlLatBHelp", rlCopy.bHelp);
}

function updateLimiterAlgorithmCopy() {
  updateWindowRowSummaries();
}

function updateDistributionPreviews() {
  updateDistributionFieldLabels();
  updateLimiterAlgorithmCopy();
  const getNum = (id) => Number(document.getElementById(id).value);
  const durationSec = getNum("durationSec");
  const rps = getNum("rps");
  const burstiness = getNum("burstiness");
  const trafficNoise = document.getElementById("trafficNoise").checked;
  setText("trafficPreviewLabel", trafficPreviewLabel(durationSec, rps, burstiness, trafficNoise));
  drawSparkline("trafficPreview", buildTrafficPreview(durationSec, rps, burstiness, trafficNoise), "#1a73e8");
  const windows = readWindows();
  setText("limiterPreviewLabel", limiterPreviewLabel(windows, document.getElementById("limiterType").value));
  drawLimiterWindowPreview("limiterPreview", windows, document.getElementById("limiterType").value, "#d93025");
  drawDistributionPreview(
    "latencyPreview",
    "latencyPreviewLabel",
    document.getElementById("latencyDist").value,
    getNum("latA"),
    getNum("latB"),
    "#5f6368"
  );
  drawDistributionPreview(
    "depLatencyPreview",
    "depLatencyPreviewLabel",
    document.getElementById("depLatencyDist").value,
    getNum("depLatA"),
    getNum("depLatB"),
    "#7b1fa2"
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
const UI_STATE_VERSION = 14;
const PANEL_STATE_STORAGE_KEY = "rl_sim_collapsed_panels";
const CONTROL_IDS = [
  "durationSec",
  "stepMs",
  "rps",
  "burstiness",
  "trafficNoise",
  "maxConcurrent",
  "queueCapacity",
  "maxQueueWaitMs",
  "limiterType",
  "latencyDist",
  "latA",
  "latB",
  "rlLatencyDist",
  "rlLatA",
  "rlLatB",
  "depMaxConcurrent",
  "depQueueCapacity",
  "depMaxQueueWaitMs",
  "depLatencyDist",
  "depLatA",
  "depLatB"
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

function saveCollapsedPanelsToStorage() {
  try {
    const payload = Object.fromEntries(collapsedPanels.entries());
    window.localStorage.setItem(PANEL_STATE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
  }
}

function loadCollapsedPanelsFromStorage() {
  try {
    const raw = window.localStorage.getItem(PANEL_STATE_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
    visibility: Object.fromEntries(seriesVisibility.entries()),
    latencyVisibility: Object.fromEntries(latencyVisibility.entries()),
    collapsedPanels: Object.fromEntries(collapsedPanels.entries())
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
        if (el.type === "checkbox") el.checked = Boolean(saved.controls[id]);
        else el.value = String(saved.controls[id]);
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

  refreshRangeInputs();

  if (saved.visibility && typeof saved.visibility === "object") {
    for (const [key, val] of Object.entries(saved.visibility)) {
      seriesVisibility.set(key, Boolean(val));
    }
  }

  if (saved.latencyVisibility && typeof saved.latencyVisibility === "object") {
    for (const [key, val] of Object.entries(saved.latencyVisibility)) {
      latencyVisibility.set(key, Boolean(val));
    }
  }

  const storedPanels = loadCollapsedPanelsFromStorage();
  if (storedPanels && typeof storedPanels === "object") {
    for (const [key, val] of Object.entries(storedPanels)) {
      collapsedPanels.set(key, Boolean(val));
    }
  } else if (saved.collapsedPanels && typeof saved.collapsedPanels === "object") {
    for (const [key, val] of Object.entries(saved.collapsedPanels)) {
      collapsedPanels.set(key, Boolean(val));
    }
  }

  applyCollapsedPanels();
  saveCollapsedPanelsToStorage();
}

const seriesVisibility = new Map();
const latencyVisibility = new Map();
const collapsedPanels = new Map();
const REQUIRED_SERIES = new Set();
const DEFAULT_VISIBLE_SERIES = new Set(["arrivals", "r429", "r503"]);
const DEFAULT_VISIBLE_LATENCY = new Set(["s200", "s429", "s503"]);
const mergedChartState = {
  fullSeries: [],
  fullTimeline: [],
  series: [],
  timeline: [],
  hoverIndex: null
};
let resultsDirty = false;
let runInProgress = false;
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
    { key: "queue", label: "App Pending", color: "#b06000", values: result.timeline.map((p) => p.queued) },
    { key: "depQueued", label: "Dependency Pending", color: "#7b1fa2", values: result.timeline.map((p) => p.depQueued) },
    { key: "active", label: "App Active", color: "#1a73e8", values: result.timeline.map((p) => p.active) },
    { key: "depActive", label: "Dependency Active", color: "#5e35b1", values: result.timeline.map((p) => p.depActive) },
    { key: "arrivals", label: "Incoming Traffic/s", color: "#3c4043", values: result.timeline.map((p) => p.arrivalsPerSec), emphasis: true },
    { key: "expectedTraffic", label: "Expected Traffic/s", color: "#9aa0a6", values: result.timeline.map((p) => p.expectedArrivalsPerSec ?? p.arrivalsPerSec) },
    { key: "rlPending", label: "Limiter Queue", color: "#59636e", values: result.timeline.map((p) => p.limiterPending) }
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
        visible.length ? visible : [],
        mergedChartState.fullTimeline,
        mergedChartState.hoverIndex
      );
      saveStateToCookie();
    });
    root.appendChild(wrapper);
  }
}

function buildLatencySeries(result) {
  return [
    { key: "s200", label: `HTTP 200 (${formatNum(result.latency.byStatus.s200.length)})`, color: "#188038", samples: result.latency.byStatus.s200, emphasis: true },
    { key: "s429", label: `HTTP 429 (${formatNum(result.latency.byStatus.s429.length)})`, color: "#d93025", samples: result.latency.byStatus.s429, emphasis: true },
    { key: "s503", label: `HTTP 503 (${formatNum(result.latency.byStatus.s503.length)})`, color: "#a142f4", samples: result.latency.byStatus.s503, emphasis: true },
    { key: "overall", label: `Overall (${formatNum(result.latency.samples.length + result.latency.byStatus.s429.length + result.latency.byStatus.s503.length)})`, color: "#5f6368", samples: [...result.latency.samples, ...result.latency.byStatus.s429, ...result.latency.byStatus.s503] }
  ];
}

function renderLatencyToggles(series, result) {
  const root = document.getElementById("latencySeriesToggles");
  if (!root) return;
  root.innerHTML = "";
  for (const s of series) {
    if (!latencyVisibility.has(s.key)) latencyVisibility.set(s.key, DEFAULT_VISIBLE_LATENCY.has(s.key));
    const wrapper = document.createElement("label");
    wrapper.innerHTML = `
      <input type="checkbox" ${latencyVisibility.get(s.key) ? "checked" : ""} />
      <span>${s.label}</span>
    `;
    wrapper.style.setProperty("--legend-color", s.color);
    wrapper.querySelector("input").addEventListener("change", (e) => {
      latencyVisibility.set(s.key, e.target.checked);
      updateLatencyChart(result);
      saveStateToCookie();
    });
    root.appendChild(wrapper);
  }
}

function updateLatencyChart(result) {
  const latencySeries = buildLatencySeries(result);
  const visible = latencySeries.filter((s) => latencyVisibility.get(s.key));
  drawLatencyHistogram(visible);
}

const DEFAULT_COLLAPSED_PANELS = {
  trafficPanel: true,
  limiterPanel: true,
  backendPanel: true,
  dependencyPanel: true,
  controlPlanePanel: true
};

function applyCollapsedPanels() {
  document.querySelectorAll('.sidebar .panel.controls').forEach((panel) => {
    const key = panel.id;
    const collapsed = collapsedPanels.has(key) ? collapsedPanels.get(key) : Boolean(DEFAULT_COLLAPSED_PANELS[key]);
    panel.classList.toggle('is-collapsed', collapsed);
    const btn = panel.querySelector('.panel-collapse-btn');
    if (btn) {
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.textContent = collapsed ? 'Expand' : 'Collapse';
    }
  });
}

function initCollapsiblePanels() {
  document.querySelectorAll('.sidebar .panel.controls').forEach((panel) => {
    if (!panel.id) return;
    if (!collapsedPanels.has(panel.id) && Object.prototype.hasOwnProperty.call(DEFAULT_COLLAPSED_PANELS, panel.id)) {
      collapsedPanels.set(panel.id, DEFAULT_COLLAPSED_PANELS[panel.id]);
    }
    const heading = panel.querySelector('.panel-heading');
    if (!heading || heading.querySelector('.panel-collapse-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'panel-collapse-btn';
    btn.addEventListener('click', () => {
      const next = !panel.classList.contains('is-collapsed');
      collapsedPanels.set(panel.id, next);
      applyCollapsedPanels();
      saveCollapsedPanelsToStorage();
      saveStateToCookie();
    });
    heading.appendChild(btn);
  });
  applyCollapsedPanels();
  saveCollapsedPanelsToStorage();
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

function updateRunButton() {
  const button = document.getElementById("runBtn");
  if (!button) return;
  const state = runInProgress ? "running" : resultsDirty ? "stale" : "current";
  button.dataset.state = state;
  button.disabled = runInProgress;
  button.innerHTML = runInProgress
    ? "<span>Running Simulation</span><small>Updating charts</small>"
    : resultsDirty
      ? "<span>Run Simulation</span><small>Parameters changed</small>"
      : "<span>Run Simulation</span><small>Results current</small>";
}

function markConfigChanged() {
  resultsDirty = true;
  updateRunButton();
}

function markResultsCurrent() {
  resultsDirty = false;
  updateRunButton();
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

function refreshRangeInputs() {
  document.querySelectorAll('.range-input').forEach((range) => {
    const target = document.getElementById(range.dataset.syncTarget);
    if (target) range.value = target.value;
  });
}

function syncRangeInputs() {
  document.querySelectorAll('.range-input').forEach((range) => {
    if (range.dataset.bound === "1") return;
    const target = document.getElementById(range.dataset.syncTarget);
    if (!target) return;
    range.dataset.bound = "1";
    const syncFromTarget = () => { range.value = target.value; };
    range.addEventListener('input', () => {
      target.value = range.value;
      target.dispatchEvent(new Event('input', { bubbles: true }));
    });
    target.addEventListener('input', syncFromTarget);
    syncFromTarget();
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
    updateDistributionPreviews();
    saveStateToCookie();
    markConfigChanged();
  });

  const handleInput = () => {
    updateWindowRowSummaries();
    updateDistributionPreviews();
    saveStateToCookie();
    markConfigChanged();
  };
  windowField.input.addEventListener("input", handleInput);
  limitField.input.addEventListener("input", handleInput);

  document.getElementById("windowRows").appendChild(row);
  updateWindowRowSummaries();
  updateDistributionPreviews();
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
    trafficNoise: document.getElementById("trafficNoise").checked,
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
    latB: getNum("latB"),
    depMaxConcurrent: clamp(getNum("depMaxConcurrent"), 1, 100000),
    depQueueCapacity: clamp(getNum("depQueueCapacity"), 0, 1000000),
    depMaxQueueWaitMs: clamp(getNum("depMaxQueueWaitMs"), 0, 600000),
    depLatencyDist: document.getElementById("depLatencyDist").value,
    depLatA: getNum("depLatA"),
    depLatB: getNum("depLatB")
  };
}

function runAndRender(options = {}) {
  const cfg = readConfig();
  const result = runSimulation(cfg);
  const baseline = runSimulation({ ...cfg, windows: [] });
  renderKpis(result, baseline);
  updateDistributionPreviews();

  const merged = buildMergedSeries(result);
  renderSeriesToggles(merged);
  const visible = merged.filter((s) => s.required || REQUIRED_SERIES.has(s.key) || seriesVisibility.get(s.key));
  mergedChartState.fullSeries = merged;
  mergedChartState.fullTimeline = result.timeline;
  setMergedChartDisplay(visible, result.timeline);
  renderLatencyToggles(buildLatencySeries(result), result);
  updateLatencyChart(result);
  renderLatencyStats(result);
  saveStateToCookie();
  markResultsCurrent();
  if (options.scrollToResults) scrollToResults();
}

function runWithAnimation(options = {}) {
  if (runInProgress) return;
  runInProgress = true;
  updateRunButton();
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      runAndRender(options);
      runInProgress = false;
      updateRunButton();
    });
  });
}

function boot() {
  const mergedChart = document.getElementById("mergedChart");
  mergedChart.addEventListener("mousemove", renderMergedChartTooltip);
  mergedChart.addEventListener("mouseleave", hideMergedChartTooltip);
  document.getElementById("addWindowBtn").addEventListener("click", () => {
    addWindowRow(1000, 30);
    saveStateToCookie();
    markConfigChanged();
  });
  document.getElementById("runBtn").addEventListener("click", () => runWithAnimation({ scrollToResults: true }));
  updateRunButton();
  initCollapsiblePanels();
  syncRangeInputs();
  refreshRangeInputs();
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

  addWindowRow(1000, 30);
  applyStateToUi(loadStateFromCookie());
  runAndRender();
  updateRunButton();
}

boot();
