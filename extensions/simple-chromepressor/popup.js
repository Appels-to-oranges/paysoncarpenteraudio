const statusText = document.getElementById("status-text");
const toggleButton = document.getElementById("toggle-compression");

const FIXED_SETTINGS = {
  threshold: -24,
  ratio: 20,
  attack: 0.001,
  release: 0.01,
  gain: 1.1,
};
const AUTO_THRESHOLD_MEASURE_MS = 5000;
const TARGET_REDUCTION_DB = 6;

let streamActive = false;
let activeTabId = null;

function renderState() {
  if (streamActive) {
    statusText.textContent = "Compression is ON.";
    toggleButton.textContent = "Stop Capture";
    toggleButton.classList.remove("btn-start");
    toggleButton.classList.add("btn-stop");
  } else {
    statusText.textContent = "Compression is OFF.";
    toggleButton.textContent = "Add Compression";
    toggleButton.classList.remove("btn-stop");
    toggleButton.classList.add("btn-start");
  }
}

async function loadInitialState() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  if (!activeTab?.id) {
    statusText.textContent = "No active tab found.";
    toggleButton.disabled = true;
    return;
  }

  activeTabId = activeTab.id;

  try {
    const response = await chrome.runtime.sendMessage({ type: "get-compressor-settings" });
    streamActive = !!response?.streamActive;
  } catch (_) {
    streamActive = false;
  }

  renderState();
}

async function toggleCompression() {
  if (activeTabId == null) return;

  toggleButton.disabled = true;
  statusText.textContent = "Working...";

  try {
    if (!streamActive) {
      const baseSettings = { ...FIXED_SETTINGS };
      const startResponse = await chrome.runtime.sendMessage({
        type: "start-streaming",
        data: { targetTabId: activeTabId },
      });
      if (!startResponse?.success) {
        statusText.textContent = "Could not start compression.";
        return;
      }

      const baseSettingsResponse = await chrome.runtime.sendMessage({
        type: "update-compressor-settings",
        data: baseSettings,
      });
      if (!baseSettingsResponse?.success) {
        statusText.textContent = "Started, but settings failed.";
        return;
      }

      statusText.textContent = "Listening for 5 seconds...";
      const measurement = await chrome.runtime.sendMessage({
        type: "measure-input-level",
        data: { durationMs: AUTO_THRESHOLD_MEASURE_MS },
      });

      if (measurement?.success && typeof measurement.averageInputLevelDb === "number") {
        const ratio = FIXED_SETTINGS.ratio;
        const idealOffsetDb = (TARGET_REDUCTION_DB * ratio) / (ratio - 1);
        const ratioRange = 20 - 2;
        const lowRatioExtraDb = 10 * (20 - ratio) / ratioRange;
        const highRatioExtraDb = 10 * (ratio - 2) / ratioRange;
        const newThreshold = measurement.averageInputLevelDb - idealOffsetDb - lowRatioExtraDb - highRatioExtraDb;
        baseSettings.threshold = Math.max(-100, Math.min(0, newThreshold));
      }

      const finalSettingsResponse = await chrome.runtime.sendMessage({
        type: "update-compressor-settings",
        data: baseSettings,
      });
      if (!finalSettingsResponse?.success) {
        statusText.textContent = "Started, but final tune failed.";
        return;
      }

      streamActive = true;
    } else {
      const stopResponse = await chrome.runtime.sendMessage({ type: "stop-streaming" });
      if (!stopResponse?.success) {
        statusText.textContent = "Could not stop capture.";
        return;
      }
      streamActive = false;
    }

    renderState();
  } catch (_) {
    statusText.textContent = "Something went wrong.";
  } finally {
    toggleButton.disabled = false;
  }
}

toggleButton.addEventListener("click", toggleCompression);
document.addEventListener("DOMContentLoaded", loadInitialState);
