const log = (...args) => console.log("%c[popup.js]", "color: blue; font-weight: bold;", ...args);
const error = (...args) => console.error("%c[popup.js ERROR]", "color: red; font-weight: bold;", ...args);

const NUM_BANDS = 4;
const POINT_COLORS = ["#e06c6c", "#e6c229", "#6bc96b", "#b88fd9"];
const DEFAULT_BANDS = [
  { frequency: 50, gainDb: 0, Q: 1 },
  { frequency: 100, gainDb: 0, Q: 1 },
  { frequency: 200, gainDb: 0, Q: 1 },
  { frequency: 2000, gainDb: 0, Q: 1 },
];
const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const GAIN_MIN = -20;
const GAIN_MAX = 20;
const Q_MIN = 0.3;
const Q_MAX = 10;
const POLL_MS = 40;
const SPECTRUM_DB_MIN = -60;
const SPECTRUM_DB_MAX = 0;
const CHART_GAIN_TOP = 20;
const CHART_GAIN_BOTTOM_DEFAULT = -60;
const CURVE_SAMPLES = 120;
const STORAGE_CHART_ZOOM = "eqChartZoom";
const STORAGE_CHART_SLOPE = "eqChartSlope";
const STORAGE_SMOOTHING = "eqSmoothing";
const STORAGE_CHART_RESOLUTION = "eqChartResolution";
const CHART_BASE_WIDTH = 400;
const CHART_BASE_HEIGHT = 200;

let bands = DEFAULT_BANDS.map((b) => ({ ...b }));
let spectrumData = null;
let spectrumInputData = null;
let canvas, ctx;
let canvasWidth = 400;
let canvasHeight = 200;
let chartTop = 0;
let chartBottom = 0;
let chartGainBottom = CHART_GAIN_BOTTOM_DEFAULT;
let padding = { top: 10, right: 12, bottom: 24, left: 36 };
let dragIndex = -1;
let qAdjustIndex = -1;
let lastQAdjustY = 0;
const Q_ADJUST_SENSITIVITY = 0.03;
/** When pointer is locked, Q change per pixel of movementY */
const Q_ADJUST_MOVEMENT_SENSITIVITY = 0.02;
let chartBoostDb = 20;
let slopeDbPerOct = 3;
let activeTabId = null;
let chartResolutionScale = 2;

function getSortedOrder() {
  return bands.map((_, i) => i).sort((a, b) => bands[a].frequency - bands[b].frequency);
}

function freqToX(freq) {
  const logMin = Math.log(FREQ_MIN);
  const logMax = Math.log(FREQ_MAX);
  const t = (Math.log(Math.max(FREQ_MIN, Math.min(FREQ_MAX, freq))) - logMin) / (logMax - logMin);
  return padding.left + t * (canvasWidth - padding.left - padding.right);
}

function xToFreq(x) {
  const logMin = Math.log(FREQ_MIN);
  const logMax = Math.log(FREQ_MAX);
  const t = (x - padding.left) / (canvasWidth - padding.left - padding.right);
  return Math.exp(logMin + t * (logMax - logMin));
}

function gainToY(gain) {
  const t = (gain - chartGainBottom) / (CHART_GAIN_TOP - chartGainBottom);
  return chartBottom - t * (chartBottom - chartTop);
}

function yToGain(y) {
  const t = (chartBottom - y) / (chartBottom - chartTop);
  return chartGainBottom + t * (CHART_GAIN_TOP - chartGainBottom);
}

function dbToY(db) {
  if (db <= chartGainBottom) return chartBottom;
  if (db >= CHART_GAIN_TOP) return chartTop;
  const t = (db - chartGainBottom) / (CHART_GAIN_TOP - chartGainBottom);
  return chartBottom - t * (chartBottom - chartTop);
}

function getEqGainAtFreq(freq) {
  let totalDb = 0;
  const f = Math.max(1, freq);
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const f0 = Math.max(1, b.frequency);
    const g = b.gainDb;
    const q = Math.max(Q_MIN, Math.min(Q_MAX, b.Q));
    const log2Ratio = Math.log2(f / f0);
    const bell = Math.exp(-2 * q * q * log2Ratio * log2Ratio);
    totalDb += g * bell;
  }
  return totalDb;
}

function hitTestPoint(x, y) {
  const r = 8;
  for (let i = 0; i < bands.length; i++) {
    const px = freqToX(bands[i].frequency);
    const py = gainToY(bands[i].gainDb);
    if (Math.hypot(x - px, y - py) <= r) return i;
  }
  return -1;
}

function drawGrid() {
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  const freqTicks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  for (const f of freqTicks) {
    const x = freqToX(f);
    ctx.beginPath();
    ctx.moveTo(x, chartTop);
    ctx.lineTo(x, chartBottom);
    ctx.stroke();
  }
  for (let g = chartGainBottom; g <= CHART_GAIN_TOP; g += 10) {
    const y = gainToY(g);
    if (y < chartTop || y > chartBottom) continue;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(canvasWidth - padding.right, y);
    ctx.stroke();
  }
  const zeroY = gainToY(0);
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, zeroY);
  ctx.lineTo(canvasWidth - padding.right, zeroY);
  ctx.stroke();
}

function drawEqCurve() {
  if (bands.length === 0) return;
  const chartLeft = padding.left;
  const chartRight = canvasWidth - padding.right;
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = 0; i <= CURVE_SAMPLES; i++) {
    const t = i / CURVE_SAMPLES;
    const logMin = Math.log(FREQ_MIN);
    const logMax = Math.log(FREQ_MAX);
    const freq = Math.exp(logMin + t * (logMax - logMin));
    const gainDb = getEqGainAtFreq(freq);
    const x = chartLeft + t * (chartRight - chartLeft);
    const y = gainToY(Math.max(chartGainBottom, Math.min(CHART_GAIN_TOP, gainDb)));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  const nodeColor = "#b8b8b8";
  bands.forEach((b, i) => {
    const x = freqToX(b.frequency);
    const y = gainToY(b.gainDb);
    ctx.fillStyle = (dragIndex >= 0 && i === dragIndex) ? "#ffffff" : nodeColor;
    ctx.strokeStyle = (dragIndex >= 0 && i === dragIndex) ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.35)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
}

function drawSpectrumFill(spectrum, fillStyle, strokeStyle) {
  if (!spectrum || spectrum.length === 0) return;
  const chartLeft = padding.left;
  const chartRight = canvasWidth - padding.right;
  const n = spectrum.length;
  ctx.fillStyle = fillStyle;
  ctx.beginPath();
  ctx.moveTo(chartLeft, chartBottom);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const freq = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t);
    const x = freqToX(freq);
    const db = spectrum[i];
    const slopeOffset = slopeDbPerOct * Math.log2(Math.max(freq, 20) / 20);
    const displayDb = typeof db === "number" ? db + chartBoostDb + slopeOffset : chartGainBottom;
    const y = dbToY(Math.max(chartGainBottom, displayDb));
    if (i === 0) ctx.lineTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.lineTo(chartRight, chartBottom);
  ctx.closePath();
  ctx.fill();
  if (strokeStyle) {
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawSpectrum() {
  const chartLeft = padding.left;
  const chartRight = canvasWidth - padding.right;
  const n = spectrumData ? spectrumData.length : 0;
  if (n === 0) return;

  if (spectrumInputData && spectrumInputData.length === n) {
    drawSpectrumFill(spectrumInputData, "rgba(70,90,110,0.4)", "rgba(90,110,130,0.3)");
  }
  if (spectrumData && spectrumData.length === n) {
    drawSpectrumFill(spectrumData, "rgba(100,120,140,0.4)", "rgba(120,140,160,0.3)");
  }
}

function drawLabels() {
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let g = chartGainBottom; g <= CHART_GAIN_TOP; g += 20) {
    const y = gainToY(g);
    if (y < chartTop || y > chartBottom) continue;
    ctx.fillText(g + " dB", padding.left - 6, y);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const freqTicks = [20, 100, 500, "1k", "2k", "5k", "10k", "20k"];
  const freqVals = [20, 100, 500, 1000, 2000, 5000, 10000, 20000];
  freqVals.forEach((f, i) => {
    const x = freqToX(f);
    const label = typeof freqTicks[i] === "string" ? freqTicks[i] : String(freqTicks[i]);
    ctx.fillText(label, x, chartBottom + 4);
  });
}

const RESOLUTION_SCALES = [1, 2, 3, 4, 6];
function resolutionScaleToBins(scale) {
  const s = Number(scale);
  if (s === 1) return 64;
  if (s === 2) return 128;
  if (s === 3) return 256;
  if (s === 4) return 512;
  if (s === 6) return 1024;
  return 128;
}

function applyChartResolution(scale) {
  const n = Number(scale);
  const s = RESOLUTION_SCALES.includes(n) ? n : 6;
  chartResolutionScale = s;
  if (!canvas) return s;
  canvas.width = CHART_BASE_WIDTH * s;
  canvas.height = CHART_BASE_HEIGHT * s;
  canvasWidth = CHART_BASE_WIDTH;
  canvasHeight = CHART_BASE_HEIGHT;
  return s;
}

const STORAGE_GAIN_MATCHING = "eqGainMatching";
const STORAGE_LIMITER = "eqLimiter";
const STORAGE_OUTPUT_GAIN = "eqOutputGain";
let gainMatchingEnabled = false;
let limiterEnabled = false;
let savedGainDb = 0;

function roundDb(db) {
  return Math.round(db * 10) / 10;
}

function setOutputGainFromSlider() {
  const el = document.getElementById("output-gain-slider");
  const valEl = document.getElementById("output-gain-value");
  if (!el || !valEl) return;
  const db = roundDb(parseFloat(el.value));
  valEl.textContent = (db >= 0 ? "+" : "") + db + " dB";
  chrome.storage.local.set({ [STORAGE_OUTPUT_GAIN]: db }).catch(() => {});
  chrome.runtime.sendMessage({ type: "apply-gain-match", data: { gainMatchDb: db } }).catch(() => {});
}

function applyGainFromPeaks(peakInputDb, peakPreLimiterDb) {
  const gainMatchDb = roundDb(Math.max(-40, Math.min(20, peakInputDb - peakPreLimiterDb)));
  const slider = document.getElementById("output-gain-slider");
  const valEl = document.getElementById("output-gain-value");
  if (slider) slider.value = String(gainMatchDb);
  if (valEl) valEl.textContent = (gainMatchDb >= 0 ? "+" : "") + gainMatchDb + " dB";
  chrome.storage.local.set({ [STORAGE_OUTPUT_GAIN]: gainMatchDb }).catch(() => {});
  chrome.runtime.sendMessage({ type: "apply-gain-match", data: { gainMatchDb } }).catch(() => {});
}

const PEAK_HOLD_MIN_MS = 2000;
/** Delay after a band change before applying autogain, so we don't react to a single moment (e.g. dialog). */
const APPLY_GAIN_DELAY_MS = 3000;

let peakInputDb = -100;
let peakPreLimiterDb = -100;
let peakHoldIntervalId = null;
let peakHoldStartTime = null;

function startPeakHold() {
  if (gainMatchAfterReleaseTimeoutId) {
    clearTimeout(gainMatchAfterReleaseTimeoutId);
    gainMatchAfterReleaseTimeoutId = null;
  }
  peakHoldStartTime = Date.now();
  peakInputDb = -100;
  peakPreLimiterDb = -100;
  if (peakHoldIntervalId) clearInterval(peakHoldIntervalId);
  peakHoldIntervalId = setInterval(() => {
    chrome.runtime.sendMessage({ type: "get-eq-stats" }, (stats) => {
      if (stats && typeof stats.inputLevelDb === "number") peakInputDb = Math.max(peakInputDb, stats.inputLevelDb);
      const outDb = typeof stats?.preLimiterLevelDb === "number" ? stats.preLimiterLevelDb : stats?.outputLevelDb;
      if (typeof outDb === "number") peakPreLimiterDb = Math.max(peakPreLimiterDb, outDb);
    });
  }, 50);
}

function stopPeakHold() {
  if (peakHoldIntervalId) {
    clearInterval(peakHoldIntervalId);
    peakHoldIntervalId = null;
  }
}

let gainMatchAfterReleaseTimeoutId = null;

function applyGainMatchAfterRelease() {
  if (gainMatchAfterReleaseTimeoutId) clearTimeout(gainMatchAfterReleaseTimeoutId);
  const runApply = () => {
    gainMatchAfterReleaseTimeoutId = null;
    stopPeakHold();
    if (!gainMatchingEnabled) return;
    applyGainFromPeaks(peakInputDb, peakPreLimiterDb);
  };
  const elapsed = peakHoldStartTime != null ? Date.now() - peakHoldStartTime : 0;
  const remainingMinMs = Math.max(0, PEAK_HOLD_MIN_MS - elapsed);
  const waitMs = Math.max(APPLY_GAIN_DELAY_MS, remainingMinMs);
  gainMatchAfterReleaseTimeoutId = setTimeout(runApply, waitMs);
}

function draw() {
  if (!ctx) return;
  chartTop = padding.top;
  chartBottom = canvasHeight - padding.bottom;
  chartGainBottom = CHART_GAIN_BOTTOM_DEFAULT + chartBoostDb;

  ctx.save();
  ctx.scale(chartResolutionScale, chartResolutionScale);

  ctx.fillStyle = "#2a2a2a"; /* match --bg */
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  drawSpectrum();
  drawGrid();
  drawEqCurve();
  drawLabels();

  ctx.restore();
}

function syncBandsToInfoPanel() {
  const order = getSortedOrder();
  for (let i = 0; i < NUM_BANDS; i++) {
    const row = document.querySelector(`.info-row[data-row="${i}"]`);
    if (!row) return;
    const bi = order[i];
    const b = bands[bi];
    const freqInput = row.querySelector(".info-freq-input");
    const gainInput = row.querySelector(".info-gain-input");
    const qInput = row.querySelector(".info-q-input");
    const qDial = row.querySelector(".info-q-dial");
    if (freqInput) freqInput.value = b.frequency;
    if (gainInput) gainInput.value = b.gainDb;
    if (qInput) qInput.value = b.Q;
    if (qDial) qDial.value = b.Q;
  }
}

function syncInfoPanelToBands() {
  const order = getSortedOrder();
  for (let i = 0; i < NUM_BANDS; i++) {
    const row = document.querySelector(`.info-row[data-row="${i}"]`);
    if (!row) return;
    const bi = order[i];
    const freqInput = row.querySelector(".info-freq-input");
    const gainInput = row.querySelector(".info-gain-input");
    const qInput = row.querySelector(".info-q-input");
    if (freqInput) bands[bi].frequency = Math.max(FREQ_MIN, Math.min(FREQ_MAX, parseFloat(freqInput.value) || bands[bi].frequency));
    if (gainInput) bands[bi].gainDb = Math.max(GAIN_MIN, Math.min(GAIN_MAX, parseFloat(gainInput.value) ?? 0));
    if (qInput) bands[bi].Q = Math.max(Q_MIN, Math.min(Q_MAX, parseFloat(qInput.value) || 1));
  }
}

function sendEqSettings() {
  syncInfoPanelToBands();
  const payload = {
    bands: bands.map((b) => ({ frequency: b.frequency, gainDb: b.gainDb, Q: b.Q })),
    masterGain: 1,
  };
  chrome.runtime.sendMessage({ type: "update-eq-settings", data: payload }).catch(() => {});
}

function resetToFlat() {
  bands = DEFAULT_BANDS.map((b) => ({ ...b }));
  syncBandsToInfoPanel();
  const gainSlider = document.getElementById("output-gain-slider");
  const gainValue = document.getElementById("output-gain-value");
  if (gainSlider) gainSlider.value = "0";
  if (gainValue) gainValue.textContent = "0 dB";
  chrome.storage.local.set({ [STORAGE_OUTPUT_GAIN]: 0 }).catch(() => {});
  chrome.runtime.sendMessage({ type: "apply-gain-match", data: { gainMatchDb: 0 } }).catch(() => {});
  draw();
  sendEqSettings();
  log("Reset to default (50, 100, 200, 2k Hz; 0 dB; Q 1).");
}

function onMouseDown(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const xBuf = (e.clientX - rect.left) * scaleX;
  const yBuf = (e.clientY - rect.top) * scaleY;
  const x = xBuf / chartResolutionScale;
  const y = yBuf / chartResolutionScale;
  const hit = hitTestPoint(x, y);
  if (e.ctrlKey && hit >= 0) {
    qAdjustIndex = hit;
    lastQAdjustY = gainToY(bands[hit].gainDb);
    dragIndex = -1;
    canvas.requestPointerLock();
  } else {
    dragIndex = hit;
    qAdjustIndex = -1;
    if (dragIndex >= 0) startPeakHold();
  }
  updateBandHighlight();
}

function startStreamIfNeededThenSendSettings() {
  if (!activeTabId) {
    sendEqSettings();
    return;
  }
  chrome.runtime.sendMessage({ type: "start-streaming", data: { targetTabId: activeTabId } }, (response) => {
    if (response?.success) log("Capture started (band adjusted).");
    sendEqSettings();
  });
}

function onMouseMove(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const xBuf = (e.clientX - rect.left) * scaleX;
  const yBuf = (e.clientY - rect.top) * scaleY;
  const x = xBuf / chartResolutionScale;
  const y = yBuf / chartResolutionScale;

  if (dragIndex >= 0 && e.ctrlKey) {
    if (qAdjustIndex < 0) {
      qAdjustIndex = dragIndex;
      lastQAdjustY = gainToY(bands[dragIndex].gainDb);
    }
    const dy = lastQAdjustY - y;
    lastQAdjustY = y;
    const b = bands[dragIndex];
    b.Q = Math.max(Q_MIN, Math.min(Q_MAX, Math.round((b.Q + dy * Q_ADJUST_SENSITIVITY) * 100) / 100));
    syncBandsToInfoPanel();
    updateBandHighlight();
    draw();
    startStreamIfNeededThenSendSettings();
    return;
  }
  if (dragIndex >= 0 && qAdjustIndex >= 0) {
    return;
  }
  if (dragIndex >= 0) {
    qAdjustIndex = -1;
    const freq = Math.max(FREQ_MIN, Math.min(FREQ_MAX, xToFreq(x)));
    const gainDb = Math.max(GAIN_MIN, Math.min(GAIN_MAX, yToGain(y)));
    bands[dragIndex].frequency = Math.round(freq);
    bands[dragIndex].gainDb = Math.round(gainDb * 10) / 10;
    syncBandsToInfoPanel();
    updateBandHighlight();
    draw();
    startStreamIfNeededThenSendSettings();
    return;
  }
  if (qAdjustIndex >= 0) {
    const dy = lastQAdjustY - y;
    lastQAdjustY = y;
    const b = bands[qAdjustIndex];
    b.Q = Math.max(Q_MIN, Math.min(Q_MAX, Math.round((b.Q + dy * Q_ADJUST_SENSITIVITY) * 100) / 100));
    syncBandsToInfoPanel();
    updateBandHighlight();
    draw();
    startStreamIfNeededThenSendSettings();
  }
}

function onMouseUp() {
  const hadDrag = dragIndex >= 0;
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  dragIndex = -1;
  qAdjustIndex = -1;
  updateBandHighlight();
  if (hadDrag) applyGainMatchAfterRelease();
}

function onKeyDown(e) {
  if (e.key === "Control" && dragIndex >= 0 && qAdjustIndex < 0) {
    qAdjustIndex = dragIndex;
    lastQAdjustY = gainToY(bands[dragIndex].gainDb);
    canvas.requestPointerLock();
  }
}

function onKeyUp(e) {
  if (e.key === "Control") {
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    qAdjustIndex = -1;
    updateBandHighlight();
  }
}

function onMouseLeave() {
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  if (dragIndex >= 0) stopPeakHold();
  dragIndex = -1;
  qAdjustIndex = -1;
  updateBandHighlight();
}

function onPointerLockChange() {
  if (document.pointerLockElement !== canvas) {
    qAdjustIndex = -1;
    updateBandHighlight();
  }
}


function updateBandHighlight() {
  const order = getSortedOrder();
  const activeBand = dragIndex >= 0 ? dragIndex : qAdjustIndex;
  document.querySelectorAll(".info-row[data-row]").forEach((row) => {
    const rowIndex = parseInt(row.getAttribute("data-row"), 10);
    const bandIndex = order[rowIndex];
    row.classList.toggle("band-active", activeBand >= 0 && bandIndex === activeBand);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  canvas = document.getElementById("eq-canvas");
  if (!canvas) return;
  ctx = canvas.getContext("2d");
  canvasWidth = CHART_BASE_WIDTH;
  canvasHeight = CHART_BASE_HEIGHT;
  // Resolution scale and buffer size applied after loading from storage below

  try {
    const response = await chrome.runtime.sendMessage({ type: "get-eq-settings" });
    if (response?.settings?.bands?.length) {
      bands = response.settings.bands.slice(0, NUM_BANDS).map((b) => ({
        frequency: Math.max(FREQ_MIN, Math.min(FREQ_MAX, b.frequency || 1000)),
        gainDb: Math.max(GAIN_MIN, Math.min(GAIN_MAX, b.gainDb ?? 0)),
        Q: Math.max(Q_MIN, Math.min(Q_MAX, typeof b.Q === "number" ? b.Q : 1)),
      }));
      while (bands.length < NUM_BANDS) {
        bands.push({ ...DEFAULT_BANDS[bands.length] });
      }
    }
  } catch (_) {}
  syncBandsToInfoPanel();

  try {
    const stored = await chrome.storage.local.get([STORAGE_CHART_ZOOM, STORAGE_CHART_SLOPE, STORAGE_SMOOTHING, STORAGE_CHART_RESOLUTION, STORAGE_GAIN_MATCHING, STORAGE_LIMITER, STORAGE_OUTPUT_GAIN]);
    const v = stored[STORAGE_CHART_ZOOM];
    if (v === 0 || v === 20 || v === 40) chartBoostDb = v;
    const s = stored[STORAGE_CHART_SLOPE];
    if (typeof s === "number" && (s === 0 || s === 3 || s === 4.5)) slopeDbPerOct = s; else slopeDbPerOct = 3;
    const smooth = stored[STORAGE_SMOOTHING];
    const defaultSmooth = (typeof smooth === "number" && smooth >= 0 && smooth <= 1) ? smooth : 0.3;
    const zoomSelect = document.getElementById("chart-zoom-select");
    if (zoomSelect) zoomSelect.value = String(chartBoostDb);
    const slopeSelect = document.getElementById("slope-select");
    if (slopeSelect) slopeSelect.value = String(slopeDbPerOct);
    const smoothingSelect = document.getElementById("smoothing-select");
    if (smoothingSelect) smoothingSelect.value = String(defaultSmooth);
    const res = stored[STORAGE_CHART_RESOLUTION];
    const resScale = RESOLUTION_SCALES.includes(res) ? res : 6;
    applyChartResolution(resScale);
    const resolutionSelect = document.getElementById("resolution-select");
    if (resolutionSelect) resolutionSelect.value = String(resScale);
    try {
      chrome.runtime.sendMessage({ type: "update-spectrum-bins", data: { value: resolutionScaleToBins(resScale) } });
    } catch (_) {}
    gainMatchingEnabled = !!stored[STORAGE_GAIN_MATCHING];
    const gainMatchingCb = document.getElementById("gain-matching-cb");
    if (gainMatchingCb) gainMatchingCb.checked = gainMatchingEnabled;
    limiterEnabled = stored[STORAGE_LIMITER] !== false;
    const limiterCb = document.getElementById("limiter-cb");
    if (limiterCb) limiterCb.checked = limiterEnabled;
    savedGainDb = typeof stored[STORAGE_OUTPUT_GAIN] === "number" ? Math.max(-40, Math.min(20, stored[STORAGE_OUTPUT_GAIN])) : 0;
    try { chrome.runtime.sendMessage({ type: "update-limiter", data: { enabled: limiterEnabled } }); } catch (_) {}
  } catch (_) {}

  document.getElementById("settings-btn").addEventListener("click", () => {
    document.getElementById("main-view").classList.add("hidden");
    document.getElementById("settings-view").classList.remove("hidden");
  });
  document.getElementById("settings-save").addEventListener("click", async () => {
    const smoothingSelect = document.getElementById("smoothing-select");
    if (smoothingSelect) {
      const val = parseFloat(smoothingSelect.value);
      if (!Number.isNaN(val) && val >= 0 && val <= 1) {
        await chrome.storage.local.set({ [STORAGE_SMOOTHING]: val }).catch(() => {});
        try {
          await chrome.runtime.sendMessage({ type: "update-smoothing", data: { value: val } });
        } catch (_) {}
      }
    }
    const gainMatchingCb = document.getElementById("gain-matching-cb");
    if (gainMatchingCb) {
      gainMatchingEnabled = gainMatchingCb.checked;
      chrome.storage.local.set({ [STORAGE_GAIN_MATCHING]: gainMatchingEnabled }).catch(() => {});
    }
    const limiterCb = document.getElementById("limiter-cb");
    if (limiterCb) {
      limiterEnabled = limiterCb.checked;
      chrome.storage.local.set({ [STORAGE_LIMITER]: limiterEnabled }).catch(() => {});
      try { chrome.runtime.sendMessage({ type: "update-limiter", data: { enabled: limiterEnabled } }); } catch (_) {}
    }
    document.getElementById("settings-view").classList.add("hidden");
    document.getElementById("main-view").classList.remove("hidden");
  });

  const zoomSelect = document.getElementById("chart-zoom-select");
  if (zoomSelect) {
    zoomSelect.addEventListener("change", () => {
      chartBoostDb = parseInt(zoomSelect.value, 10);
      if (Number.isNaN(chartBoostDb)) chartBoostDb = 20;
      chrome.storage.local.set({ [STORAGE_CHART_ZOOM]: chartBoostDb }).catch(() => {});
      draw();
    });
  }
  const slopeSelect = document.getElementById("slope-select");
  if (slopeSelect) {
    slopeSelect.addEventListener("change", () => {
      slopeDbPerOct = parseFloat(slopeSelect.value);
      if (Number.isNaN(slopeDbPerOct)) slopeDbPerOct = 3;
      chrome.storage.local.set({ [STORAGE_CHART_SLOPE]: slopeDbPerOct }).catch(() => {});
      draw();
    });
  }
  const resolutionSelect = document.getElementById("resolution-select");
  if (resolutionSelect) {
    resolutionSelect.addEventListener("change", () => {
      const scale = parseInt(resolutionSelect.value, 10);
      const s = applyChartResolution(Number.isNaN(scale) ? 2 : scale);
      chrome.storage.local.set({ [STORAGE_CHART_RESOLUTION]: s }).catch(() => {});
      try {
        chrome.runtime.sendMessage({ type: "update-spectrum-bins", data: { value: resolutionScaleToBins(s) } });
      } catch (_) {}
      draw();
    });
  }

  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mouseup", onMouseUp);
  canvas.addEventListener("mouseleave", onMouseLeave);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);
  document.addEventListener("pointerlockchange", onPointerLockChange);

  document.querySelectorAll(".info-freq-input, .info-gain-input").forEach((el) => {
    el.addEventListener("change", () => { syncInfoPanelToBands(); syncBandsToInfoPanel(); draw(); sendEqSettings(); });
    el.addEventListener("input", () => { syncInfoPanelToBands(); syncBandsToInfoPanel(); draw(); sendEqSettings(); });
  });
  document.querySelectorAll(".info-q-input").forEach((qInput, rowIndex) => {
    const syncQ = () => {
      syncInfoPanelToBands();
      const order = getSortedOrder();
      const bi = order[rowIndex];
      const row = qInput.closest(".info-row");
      const dial = row && row.querySelector(".info-q-dial");
      if (dial) dial.value = bands[bi].Q;
      draw();
      sendEqSettings();
    };
    qInput.addEventListener("change", syncQ);
    qInput.addEventListener("input", syncQ);
  });
  document.querySelectorAll(".info-q-dial").forEach((dial, rowIndex) => {
    dial.addEventListener("input", () => {
      const v = parseFloat(dial.value);
      const order = getSortedOrder();
      bands[order[rowIndex]].Q = v;
      const row = dial.closest(".info-row");
      const qInput = row && row.querySelector(".info-q-input");
      if (qInput) qInput.value = v;
      draw();
      sendEqSettings();
    });
  });

  document.getElementById("reset-flat").addEventListener("click", resetToFlat);

  function updateBypassButtonText(btn) {
    if (!btn) return;
    btn.textContent = btn.classList.contains("active") ? "Bypass (Active)" : "Bypass";
  }
  const bypassBtn = document.getElementById("bypass-btn");
  if (bypassBtn) {
    chrome.runtime.sendMessage({ type: "get-bypass" }, (res) => {
      if (res && typeof res.bypassed === "boolean") bypassBtn.classList.toggle("active", res.bypassed);
      updateBypassButtonText(bypassBtn);
    });
    bypassBtn.addEventListener("click", () => {
      const willBypass = !bypassBtn.classList.contains("active");
      if (willBypass) {
        const gainSlider = document.getElementById("output-gain-slider");
        const currentGainDb = gainSlider ? parseFloat(gainSlider.value) : 0;
        if (currentGainDb < -12) {
          const warnEl = document.getElementById("bypass-warning");
          if (warnEl) warnEl.classList.remove("hidden");
          return;
        }
      }
      const isActive = bypassBtn.classList.toggle("active");
      updateBypassButtonText(bypassBtn);
      chrome.runtime.sendMessage({ type: "set-bypass", data: { enabled: isActive } }, (res) => {
        if (res && typeof res.bypassed === "boolean") bypassBtn.classList.toggle("active", res.bypassed);
        updateBypassButtonText(bypassBtn);
      });
    });
  }
  const bypassWarningDismiss = document.querySelector(".bypass-warning-dismiss");
  if (bypassWarningDismiss) {
    bypassWarningDismiss.addEventListener("click", () => {
      const warnEl = document.getElementById("bypass-warning");
      if (warnEl) warnEl.classList.add("hidden");
      bypassBtn.classList.add("active");
      updateBypassButtonText(bypassBtn);
      chrome.runtime.sendMessage({ type: "set-bypass", data: { enabled: true } }, (res) => {
        if (res && typeof res.bypassed === "boolean") bypassBtn.classList.toggle("active", res.bypassed);
        updateBypassButtonText(bypassBtn);
      });
    });
  }

  const outputGainSlider = document.getElementById("output-gain-slider");
  const outputGainValue = document.getElementById("output-gain-value");
  if (outputGainSlider && outputGainValue) {
    const gainDb = roundDb(savedGainDb);
    outputGainSlider.value = String(gainDb);
    outputGainValue.textContent = (gainDb >= 0 ? "+" : "") + gainDb + " dB";
    chrome.runtime.sendMessage({ type: "apply-gain-match", data: { gainMatchDb: gainDb } }).catch(() => {});
    outputGainSlider.addEventListener("input", () => {
      const db = roundDb(parseFloat(outputGainSlider.value));
      outputGainValue.textContent = (db >= 0 ? "+" : "") + db + " dB";
      chrome.storage.local.set({ [STORAGE_OUTPUT_GAIN]: db }).catch(() => {});
      chrome.runtime.sendMessage({ type: "apply-gain-match", data: { gainMatchDb: db } }).catch(() => {});
    });
    outputGainSlider.addEventListener("change", () => setOutputGainFromSlider());
  }

  const outputLevelDisplay = document.getElementById("output-level-display");
  const clipIndicator = document.getElementById("clip-indicator");
  const pollLevel = () => {
    chrome.runtime.sendMessage({ type: "get-eq-stats" }, (stats) => {
      if (outputLevelDisplay) {
        if (stats && typeof stats.outputLevelDb === "number") {
          const db = Math.round(stats.outputLevelDb * 10) / 10;
          outputLevelDisplay.textContent = db + " dB";
          if (clipIndicator) clipIndicator.classList.toggle("on", db >= 0);
        } else {
          outputLevelDisplay.textContent = "-- dB";
          if (clipIndicator) clipIndicator.classList.remove("on");
        }
      }
    });
  };
  setInterval(pollLevel, 100);
  pollLevel();

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  if (!activeTab?.id) {
    error("No active tab.");
    draw();
    return;
  }
  activeTabId = activeTab.id;

  function applyLimiterAndGainAfterStreamStart() {
    try {
      chrome.runtime.sendMessage({ type: "update-limiter", data: { enabled: limiterEnabled } });
      const slider = document.getElementById("output-gain-slider");
      const db = slider ? roundDb(parseFloat(slider.value)) : savedGainDb;
      chrome.runtime.sendMessage({ type: "apply-gain-match", data: { gainMatchDb: db } });
    } catch (_) {}
  }

  // Auto-start capture when popup opens
  chrome.runtime.sendMessage({ type: "start-streaming", data: { targetTabId: activeTab.id } }, (response) => {
    if (response?.success) {
      sendEqSettings();
      applyLimiterAndGainAfterStreamStart();
      log("Capture started.");
    }
  });

  document.getElementById("stop-capture").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "stop-streaming" }, (response) => {
      if (response?.success) {
        spectrumData = null;
        spectrumInputData = null;
        draw();
        log("Stopped.");
      }
    });
  });

  const pollSpectrum = async () => {
    try {
      const data = await chrome.runtime.sendMessage({ type: "get-eq-spectrum" });
      if (data && Array.isArray(data.spectrumDb) && data.spectrumDb.length > 0) {
        spectrumData = data.spectrumDb;
        spectrumInputData = Array.isArray(data.spectrumInputDb) && data.spectrumInputDb.length === data.spectrumDb.length ? data.spectrumInputDb : null;
      } else {
        spectrumData = null;
        spectrumInputData = null;
      }
    } catch (_) {}
  };
  setInterval(pollSpectrum, POLL_MS);
  pollSpectrum();

  draw();
  requestAnimationFrame(function tick() {
    draw();
    requestAnimationFrame(tick);
  });
});
