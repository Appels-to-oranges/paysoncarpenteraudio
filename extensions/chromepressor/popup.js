const log = (...args) => console.log("%c[popup.js]", "color: blue; font-weight: bold;", ...args);
const error = (...args) => console.error("%c[popup.js ERROR]", "color: red; font-weight: bold;", ...args);

function formatRangeValue(value, id) {
  const n = Number(value);
  const key = (id || "").replace(/^viz-/, "") || id;
  if (key === "attack" || key === "release") return n.toFixed(3);
  if (key === "gain") return n % 1 === 0 ? n : n.toFixed(1);
  if (key === "threshold") return n % 1 === 0 ? n : n.toFixed(1);
  return value;
}

function bindRangeDisplay(inputId, valueId) {
  const input = document.getElementById(inputId);
  const display = document.getElementById(valueId);
  if (!input || !display) return;
  const update = () => { display.textContent = formatRangeValue(input.value, inputId); };
  input.addEventListener("input", update);
  update();
}

function applySettingsToVizForm(settings) {
  const ids = ["threshold", "ratio", "attack", "release", "gain"];
  ids.forEach((id) => {
    const el = document.getElementById("viz-" + id);
    if (el && settings[id] != null) {
      el.value = settings[id];
      const display = document.getElementById("viz-" + id + "-value");
      if (display) display.textContent = formatRangeValue(settings[id], "viz-" + id);
    }
  });
}

function getVisualizerSettings() {
  return {
    threshold: parseFloat(document.getElementById("viz-threshold")?.value),
    ratio: parseFloat(document.getElementById("viz-ratio")?.value),
    attack: parseFloat(document.getElementById("viz-attack")?.value),
    release: parseFloat(document.getElementById("viz-release")?.value),
    gain: parseFloat(document.getElementById("viz-gain")?.value),
  };
}

let visualizerApplyTimeout = null;
function scheduleApplyVisualizerSettings() {
  if (visualizerApplyTimeout) clearTimeout(visualizerApplyTimeout);
  visualizerApplyTimeout = setTimeout(async () => {
    visualizerApplyTimeout = null;
    if (!isVisualizerActive()) return;
    const settings = getVisualizerSettings();
    try {
      await chrome.runtime.sendMessage({ type: "update-compressor-settings", data: settings });
      applySettingsToForm(settings);
    } catch (_) {}
  }, 80);
}

function applySettingsToForm(settings) {
  ["threshold", "gain"].forEach((id) => {
    const el = document.getElementById(id);
    if (el && settings[id] != null) {
      el.value = settings[id];
      const display = document.getElementById(`${id}-value`);
      if (display) display.textContent = formatRangeValue(settings[id], id);
    }
  });
  applySettingsToVizForm(settings);
}

function formatDb(value) {
  if (value == null || typeof value !== "number") return "—";
  if (value <= -99) return "-∞";
  return value.toFixed(1);
}

function updateStatsDisplay(stats) {
  const inputEl = document.getElementById("input-level-value");
  const reductionEl = document.getElementById("gain-reduction-value");
  const fmt = (v) => { const s = formatDb(v); return s === "—" ? s : s + " dB"; };
  if (inputEl) inputEl.textContent = fmt(stats?.inputLevelDb);
  if (reductionEl) reductionEl.textContent = fmt(stats?.gainReductionDb);
}

const VISUALIZER_DURATION_SEC = 10;
const VISUALIZER_POLL_MS = 25;
const VISUALIZER_MAX_SAMPLES = Math.max(1, (VISUALIZER_DURATION_SEC * 1000) / VISUALIZER_POLL_MS);
const VISUALIZER_INPUT_RANGE_DB = 50;  // -50 to 0 dB for input
const VISUALIZER_GR_RANGE_DB = 24;     // 0 to 24 dB for gain reduction

const visualizerHistory = {
  inputLevelDb: [],
  gainReductionDb: [],
};

function showMainView() {
  document.getElementById("main-view").classList.add("active");
  document.getElementById("visualizer-view").classList.remove("active");
}

async function showVisualizerView() {
  document.getElementById("main-view").classList.remove("active");
  document.getElementById("visualizer-view").classList.add("active");
  visualizerHistory.inputLevelDb = [];
  visualizerHistory.gainReductionDb = [];
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-compressor-settings" });
    if (response?.settings && typeof response.settings === "object") {
      applySettingsToVizForm(response.settings);
    } else {
      const settings = {
        threshold: parseFloat(document.getElementById("threshold").value),
        ratio: parseFloat(document.getElementById("ratio").value),
        attack: parseFloat(document.getElementById("attack").value),
        release: parseFloat(document.getElementById("release").value),
        gain: parseFloat(document.getElementById("gain").value),
      };
      applySettingsToVizForm(settings);
    }
  } catch (_) {
    const settings = {
      threshold: parseFloat(document.getElementById("threshold").value),
      ratio: parseFloat(document.getElementById("ratio").value),
      attack: parseFloat(document.getElementById("attack").value),
      release: parseFloat(document.getElementById("release").value),
      gain: parseFloat(document.getElementById("gain").value),
    };
    applySettingsToVizForm(settings);
  }
  updateVisualizerLabels();
  drawVisualizer();
}

function isVisualizerActive() {
  const el = document.getElementById("visualizer-view");
  return el && el.classList.contains("active");
}

function updateVisualizerLabels() {
  const n = visualizerHistory.inputLevelDb.length;
  const grEl = document.getElementById("visualizer-gr-db");
  const outEl = document.getElementById("visualizer-out-db");
  if (n === 0) {
    if (grEl) grEl.textContent = "— dB";
    if (outEl) outEl.textContent = "— dB";
    return;
  }
  const gainEl = document.getElementById("viz-gain");
  const gain = gainEl ? parseFloat(gainEl.value) : 1;
  const inputDb = visualizerHistory.inputLevelDb[n - 1];
  const grDb = visualizerHistory.gainReductionDb[n - 1];
  const grText = grDb != null && Number.isFinite(grDb) ? formatDb(grDb) + " dB" : "— dB";
  const outDb = (inputDb != null && grDb != null) ? inputDb - grDb + (gain - 1) * 6 : null;
  const outText = (outDb != null && Number.isFinite(outDb) && outDb > -99)
    ? outDb.toFixed(1) + " dB"
    : "−∞ dB";
  if (grEl) grEl.textContent = grText;
  if (outEl && outEl.textContent !== outText) outEl.textContent = outText;
}

function drawVisualizer() {
  const canvas = document.getElementById("visualizer-canvas");
  if (!canvas || !isVisualizerActive()) return;

  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const padding = { top: 8, right: 8, bottom: 8, left: 8 };
  const chartLeft = padding.left;
  const chartRight = width - padding.right;
  const chartTop = padding.top;
  const chartBottom = height - padding.bottom;
  const chartWidth = chartRight - chartLeft;
  const chartHeight = chartBottom - chartTop;

  ctx.fillStyle = "#d3d3d3";
  ctx.fillRect(0, 0, width, height);

  const thresholdEl = document.getElementById("viz-threshold");
  const thresholdDb = thresholdEl ? parseFloat(thresholdEl.value) : -24;
  const showGr = document.getElementById("visualizer-gr-check")?.checked !== false;
  const showOut = document.getElementById("visualizer-out-check")?.checked === true;
  const gainEl = document.getElementById("viz-gain");
  const gain = gainEl ? parseFloat(gainEl.value) : 1;

  const inputMinDb = -VISUALIZER_INPUT_RANGE_DB;
  const inputMaxDb = 0;
  const grMaxDb = VISUALIZER_GR_RANGE_DB;

  function inputDbToY(db) {
    if (db <= inputMinDb) return chartBottom;
    if (db >= inputMaxDb) return chartTop;
    const t = (db - inputMinDb) / (inputMaxDb - inputMinDb);
    return chartBottom - t * chartHeight;
  }

  function grDbToY(db) {
    if (db <= 0) return chartTop;
    if (db >= grMaxDb) return chartBottom;
    const t = db / grMaxDb;
    return chartTop + t * chartHeight;
  }

  const inputArr = visualizerHistory.inputLevelDb;
  const grArr = visualizerHistory.gainReductionDb;
  const n = Math.min(inputArr.length, grArr.length);
  if (n === 0) return;

  // Fixed 15s window: full width = 15s, newest always at right
  const stepX = chartWidth / (VISUALIZER_MAX_SAMPLES - 1);
  function sampleIndexToX(i) {
    const slot = (VISUALIZER_MAX_SAMPLES - n) + i;
    return chartLeft + slot * stepX;
  }

  // Grey fill: incoming audio level (bottom to level), left to right, newest at right
  ctx.beginPath();
  ctx.moveTo(chartLeft, chartBottom);
  for (let i = 0; i < n; i++) {
    const db = inputArr[i] != null ? inputArr[i] : inputMinDb;
    const y = inputDbToY(db);
    const x = sampleIndexToX(i);
    if (i === 0) ctx.lineTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.lineTo(sampleIndexToX(n - 1), chartBottom);
  ctx.closePath();
  ctx.fillStyle = "rgba(80, 80, 80, 0.45)";
  ctx.fill();

  // Light blue horizontal line: threshold
  const threshY = inputDbToY(thresholdDb);
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 2]);
  ctx.beginPath();
  ctx.moveTo(chartLeft, threshY);
  ctx.lineTo(chartRight, threshY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Yellow curve: gain reduction (API reports negative dB; we show as positive amount)
  if (showGr && grArr.length > 0) {
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const raw = grArr[i] != null ? grArr[i] : 0;
      const gr = Math.abs(raw);
      const y = grDbToY(gr);
      const x = sampleIndexToX(i);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Optional: output level curve (same scale as input)
  if (showOut && inputArr.length > 0) {
    ctx.strokeStyle = "rgba(50, 120, 60, 0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const inDb = inputArr[i];
      const gr = grArr[i];
      const outDb = (inDb != null && gr != null) ? inDb - gr + (gain - 1) * 6 : inputMinDb;
      const y = inputDbToY(outDb);
      const x = sampleIndexToX(i);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  updateVisualizerLabels();
}

document.addEventListener("DOMContentLoaded", async () => {
  log("Popup loaded.");

  // Restore last compressor settings when popup is reopened
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-compressor-settings" });
    if (response?.settings && typeof response.settings === "object") {
      applySettingsToForm(response.settings);
      log("Restored compressor settings:", response.settings);
    }
  } catch (e) {
    log("No stored settings (first run or background not ready).");
  }

  ["threshold", "gain"].forEach((id) =>
    bindRangeDisplay(id, `${id}-value`)
  );

  ["viz-threshold", "viz-ratio", "viz-attack", "viz-release", "viz-gain"].forEach((id) =>
    bindRangeDisplay(id, id + "-value")
  );
  ["threshold", "ratio", "attack", "release", "gain"].forEach((id) => {
    const el = document.getElementById("viz-" + id);
    if (el) el.addEventListener("input", () => {
      updateVisualizerLabels();
      drawVisualizer();
      scheduleApplyVisualizerSettings();
    });
  });

  // Settings button: show Settings (visualizer) view
  document.getElementById("visualizer-btn").addEventListener("click", showVisualizerView);

  // Visualizer Save: apply, sync, and return to main view
  document.getElementById("visualizer-save").addEventListener("click", async () => {
    const settings = getVisualizerSettings();
    try {
      await chrome.runtime.sendMessage({ type: "update-compressor-settings", data: settings });
      applySettingsToForm(settings);
      showMainView();
    } catch (e) {
      log("Visualizer save failed:", e);
    }
  });

  // Visualizer checkboxes: redraw when toggled
  document.getElementById("visualizer-gr-check").addEventListener("change", drawVisualizer);
  document.getElementById("visualizer-out-check").addEventListener("change", drawVisualizer);

  // Poll compressor stats (input level, gain reduction) while popup is open
  const pollStats = async () => {
    try {
      const stats = await chrome.runtime.sendMessage({ type: "get-compressor-stats" });
      updateStatsDisplay(stats);
      if (isVisualizerActive() && stats) {
        const inDb = stats.inputLevelDb != null ? stats.inputLevelDb : -100;
        const grDb = stats.gainReductionDb != null ? stats.gainReductionDb : 0;
        const hi = visualizerHistory;
        hi.inputLevelDb.push(inDb);
        hi.gainReductionDb.push(grDb);
        if (hi.inputLevelDb.length > VISUALIZER_MAX_SAMPLES) {
          hi.inputLevelDb.shift();
          hi.gainReductionDb.shift();
        }
        drawVisualizer();
      }
    } catch (_) {}
  };
  pollStats();
  const statsInterval = setInterval(pollStats, VISUALIZER_POLL_MS);
  window.addEventListener("unload", () => clearInterval(statsInterval));

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];

  if (!activeTab?.id) {
    error("No valid active tab found.");
    return;
  }
  log("Active tab detected:", activeTab);

  async function applyCompressorSettings(settings) {
    const response = await chrome.runtime.sendMessage({
      type: "update-compressor-settings",
      data: settings,
    });
    return response;
  }

  function getFullSettingsFromMainAndViz() {
    return {
      threshold: parseFloat(document.getElementById("threshold")?.value),
      ratio: parseFloat(document.getElementById("viz-ratio")?.value),
      attack: parseFloat(document.getElementById("viz-attack")?.value),
      release: parseFloat(document.getElementById("viz-release")?.value),
      gain: parseFloat(document.getElementById("gain")?.value),
    };
  }

  let mainViewApplyTimeout = null;
  function scheduleApplyFromMainView() {
    if (mainViewApplyTimeout) clearTimeout(mainViewApplyTimeout);
    mainViewApplyTimeout = setTimeout(async () => {
      mainViewApplyTimeout = null;
      try {
        const response = await chrome.runtime.sendMessage({
          type: "start-streaming",
          data: { targetTabId: activeTab.id },
        });
        if (!response?.success) return;
        const settings = getFullSettingsFromMainAndViz();
        await chrome.runtime.sendMessage({ type: "update-compressor-settings", data: settings });
        applySettingsToForm(settings);
      } catch (_) {}
    }, 80);
  }

  ["threshold", "gain"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", scheduleApplyFromMainView);
  });

  const stopCaptureButton = document.getElementById("stop-capture");
  if (stopCaptureButton) {
    stopCaptureButton.addEventListener("click", async () => {
      try {
        log("Stop capture clicked.");
        const response = await chrome.runtime.sendMessage({ type: "stop-streaming" });
        if (response?.success) {
          log("Capture and compression stopped.");
          updateStatsDisplay(null);
        } else {
          error("Stop failed:", response?.error || "No response.");
        }
      } catch (err) {
        error("Stop capture error:", err);
      }
    });
  }

  const AUTO_THRESHOLD_MEASURE_MS = 4000;
  async function runAutoThreshold(targetReductionDb, button, buttonLabel) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "start-streaming",
        data: { targetTabId: activeTab.id },
      });
      if (!response?.success) {
        error("Start streaming failed:", response?.error || "No response.");
        return;
      }
      const currentSettings = {
        threshold: parseFloat(document.getElementById("threshold").value),
        ratio: parseFloat(document.getElementById("viz-ratio").value),
        attack: parseFloat(document.getElementById("viz-attack").value),
        release: parseFloat(document.getElementById("viz-release").value),
        gain: parseFloat(document.getElementById("gain").value),
      };
      await applyCompressorSettings(currentSettings);

      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "Measuring… (4 s)";

      const result = await chrome.runtime.sendMessage({
        type: "measure-input-level",
        data: { durationMs: AUTO_THRESHOLD_MEASURE_MS },
      });

      button.disabled = false;
      button.textContent = originalText;

      if (!result?.success) {
        error("Measurement failed:", result?.error || "No result.");
        return;
      }
      const ratio = parseFloat(document.getElementById("viz-ratio").value);
      if (ratio <= 1) {
        error("Ratio must be > 1.");
        return;
      }
      const averageInputLevelDb = result.averageInputLevelDb;
      const idealOffsetDb = (targetReductionDb * ratio) / (ratio - 1);
      const ratioRange = 20 - 2;
      const lowRatioExtraDb = 10 * (20 - ratio) / ratioRange;
      const highRatioExtraDb = 10 * (ratio - 2) / ratioRange;
      const newThreshold = averageInputLevelDb - idealOffsetDb - lowRatioExtraDb - highRatioExtraDb;
      const clampedThreshold = Math.max(-100, Math.min(0, newThreshold));

      const thresholdInput = document.getElementById("threshold");
      const thresholdValueEl = document.getElementById("threshold-value");
      const vizThresholdInput = document.getElementById("viz-threshold");
      const vizThresholdValueEl = document.getElementById("viz-threshold-value");
      thresholdInput.value = clampedThreshold;
      thresholdValueEl.textContent = formatRangeValue(clampedThreshold, "threshold");
      if (vizThresholdInput) { vizThresholdInput.value = clampedThreshold; }
      if (vizThresholdValueEl) { vizThresholdValueEl.textContent = formatRangeValue(clampedThreshold, "viz-threshold"); }

      const compressorSettings = {
        threshold: clampedThreshold,
        ratio: parseFloat(document.getElementById("viz-ratio").value),
        attack: parseFloat(document.getElementById("viz-attack").value),
        release: parseFloat(document.getElementById("viz-release").value),
        gain: parseFloat(document.getElementById("gain").value),
      };
      await applyCompressorSettings(compressorSettings);
      log("Auto threshold set to", clampedThreshold.toFixed(1), "dB for ~" + targetReductionDb + " dB GR at", averageInputLevelDb.toFixed(1), "dB input.");
    } catch (err) {
      error("Auto threshold error:", err);
      button.disabled = false;
      button.textContent = buttonLabel;
    }
  }

  [["auto-3db", 3, "Light"], ["auto-6db", 6, "Medium"], ["auto-12db", 12, "Heavy"]].forEach(([id, db, label]) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener("click", () => runAutoThreshold(db, btn, label));
  });
});
