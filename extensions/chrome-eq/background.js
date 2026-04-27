const log = (...args) => console.log("%c[background.js]", "color: green; font-weight: bold;", ...args);
const warn = (...args) => console.warn("%c[background.js WARNING]", "color: orange; font-weight: bold;", ...args);
const error = (...args) => console.error("%c[background.js ERROR]", "color: red; font-weight: bold;", ...args);

let streamInitialized = false;
let offscreenReady = false;
let popupPort = null;
let lastEqStats = { inputLevelDb: null, outputLevelDb: null, preLimiterLevelDb: null };
let lastEqSpectrum = null;
let lastEqSpectrumInput = null;

const STORAGE_KEY = "eqSettings";
const STORAGE_KEY_SMOOTHING = "eqSmoothing";
const DEFAULT_EQ_BANDS = [
  { frequency: 50, gainDb: 0, Q: 1 },
  { frequency: 100, gainDb: 0, Q: 1 },
  { frequency: 200, gainDb: 0, Q: 1 },
  { frequency: 2000, gainDb: 0, Q: 1 },
];
const DEFAULT_MASTER_GAIN = 1;
const DEFAULT_SMOOTHING = 0.3;
const DEFAULT_EQ_SETTINGS = { bands: DEFAULT_EQ_BANDS.map((b) => ({ ...b })), masterGain: DEFAULT_MASTER_GAIN };
let currentEqSettings = { bands: DEFAULT_EQ_BANDS.map((b) => ({ ...b })), masterGain: DEFAULT_MASTER_GAIN };
let currentSmoothing = DEFAULT_SMOOTHING;

function loadStoredSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY, STORAGE_KEY_SMOOTHING], (result) => {
      if (result[STORAGE_KEY] && typeof result[STORAGE_KEY] === "object") {
        const stored = result[STORAGE_KEY];
        if (Array.isArray(stored.bands) && stored.bands.length > 0) {
          currentEqSettings.bands = stored.bands.map((b) => ({
            frequency: typeof b.frequency === "number" ? b.frequency : 1000,
            gainDb: typeof b.gainDb === "number" ? b.gainDb : 0,
            Q: typeof b.Q === "number" ? b.Q : 1,
          }));
        }
        if (typeof stored.masterGain === "number") currentEqSettings.masterGain = stored.masterGain;
        log("Loaded EQ settings from storage:", currentEqSettings);
      }
      const s = result[STORAGE_KEY_SMOOTHING];
      if (typeof s === "number" && s >= 0 && s <= 1) currentSmoothing = s;
      resolve();
    });
  });
}

function saveStoredSettings() {
  chrome.storage.local.set({ [STORAGE_KEY]: currentEqSettings });
}

loadStoredSettings();

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  log("Checking offscreen document status:", existing);

  if (!existing) {
    try {
      log("Creating offscreen document...");
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL("offscreen.html"),
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Required for parametric EQ processing.",
      });
      log("Offscreen document created. Waiting for it to report readiness...");
      await waitForOffscreenReadySignal();
      log("Offscreen document is fully ready.");
    } catch (err) {
      error("Failed to create offscreen document:", err);
    }
  } else {
    if (!offscreenReady) {
      log("Offscreen exists but not marked ready yet. Waiting (with timeout)...");
      await waitForOffscreenReadySignal(2000);
      if (!offscreenReady) {
        warn("Offscreen ready signal not received (e.g. SW restarted); proceeding anyway.");
        offscreenReady = true;
      }
    } else {
      log("Offscreen document already exists and is ready.");
    }
  }
}

function waitForOffscreenReadySignal(timeoutMs = 10000) {
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      if (offscreenReady) {
        clearInterval(checkInterval);
        clearTimeout(timer);
        resolve();
      }
    }, 100);
    const timer = setTimeout(() => {
      clearInterval(checkInterval);
      resolve();
    }, timeoutMs);
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup-control") {
    popupPort = port;
    log("Popup connected for control.");
    port.onDisconnect.addListener(() => {
      log("Popup control disconnected.");
      popupPort = null;
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log("Message received in background.js:", message.type);

  if (message.type === "offscreen-ready") {
    log("Offscreen document reports READY.");
    offscreenReady = true;
    return;
  }

  if (message.type === "eq-stats") {
    const data = message.data || {};
    lastEqStats = {
      inputLevelDb: typeof data.inputLevelDb === "number" ? data.inputLevelDb : null,
      outputLevelDb: typeof data.outputLevelDb === "number" ? data.outputLevelDb : null,
      preLimiterLevelDb: typeof data.preLimiterLevelDb === "number" ? data.preLimiterLevelDb : null,
    };
    if (popupPort?.name === "popup-control") {
      try {
        popupPort.postMessage({ type: "eq-stats", data: lastEqStats });
      } catch (_) {}
    }
    return;
  }

  if (message.type === "get-eq-stats") {
    sendResponse(lastEqStats);
    return true;
  }

  if (message.type === "eq-spectrum") {
    const data = message.data || {};
    if (Array.isArray(data.spectrumDb)) lastEqSpectrum = data.spectrumDb;
    if (Array.isArray(data.spectrumInputDb)) lastEqSpectrumInput = data.spectrumInputDb;
    return;
  }

  if (message.type === "get-eq-spectrum") {
    sendResponse({ spectrumDb: lastEqSpectrum, spectrumInputDb: lastEqSpectrumInput });
    return true;
  }

  if (message.type === "check-offscreen") {
    chrome.offscreen.hasDocument((exists) => {
      log("Popup check-offscreen request - Exists:", exists, "Ready flag:", offscreenReady);
      sendResponse({ ready: exists });
    });
    return true;
  }

  if (message.type === "start-streaming") {
    (async () => {
      try {
        const targetTabId = message.data?.targetTabId;
        if (targetTabId == null) {
          sendResponse({ success: false, error: "Missing targetTabId" });
          return;
        }

        const exists = await chrome.offscreen.hasDocument();
        if (!exists) streamInitialized = false;

        let alreadyCaptured = false;
        try {
          const captured = await chrome.tabCapture.getCapturedTabs();
          alreadyCaptured = captured.some((info) => info.tabId === targetTabId && info.status === "active");
          log("getCapturedTabs:", captured, "alreadyCaptured:", alreadyCaptured);
        } catch (e) {
          log("getCapturedTabs failed:", e);
        }

        if (alreadyCaptured) {
          log("Tab already captured; applying EQ settings only.");
          await ensureOffscreen();
          streamInitialized = true;
          sendResponse({ success: true });
          chrome.runtime.sendMessage({ type: "update-eq-settings", data: currentEqSettings });
          return;
        }

        log("Obtaining stream ID for tab", targetTabId);
        let streamId;
        try {
          streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId });
        } catch (err) {
          error("getMediaStreamId failed:", err);
          sendResponse({ success: false, error: err?.message || String(err) });
          return;
        }

        await ensureOffscreen();
        chrome.runtime.sendMessage(
          { type: "process-stream", data: { streamId, smoothing: currentSmoothing } },
          (response) => {
            log("Response from offscreen.js:", response);
            if (response?.success) {
              streamInitialized = true;
              sendResponse({ success: true });
              chrome.runtime.sendMessage({ type: "update-eq-settings", data: currentEqSettings });
            } else {
              error("Offscreen document failed to process stream.");
              sendResponse({ success: false, error: "Failed in offscreen document." });
            }
          }
        );
      } catch (err) {
        error("Error initializing stream:", err);
        sendResponse({ success: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "update-smoothing") {
    const value = message.data?.value;
    const num = typeof value === "number" ? Math.max(0, Math.min(1, value)) : DEFAULT_SMOOTHING;
    currentSmoothing = num;
    chrome.storage.local.set({ [STORAGE_KEY_SMOOTHING]: num }).catch(() => {});
    chrome.runtime.sendMessage({ type: "update-smoothing", data: { value: num } }, () => {
      if (chrome.runtime.lastError) warn("update-smoothing offscreen:", chrome.runtime.lastError.message);
    });
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "update-spectrum-bins") {
    const value = message.data?.value;
    const bins = typeof value === "number" ? Math.max(32, Math.min(1024, value)) : 128;
    chrome.runtime.sendMessage({ type: "update-spectrum-bins", data: { value: bins } }, () => {
      if (chrome.runtime.lastError) warn("update-spectrum-bins offscreen:", chrome.runtime.lastError.message);
    });
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "apply-gain-match") {
    const gainMatchDb = message.data?.gainMatchDb;
    chrome.runtime.sendMessage({ type: "apply-gain-match", data: { gainMatchDb } }, () => {
      if (chrome.runtime.lastError) warn("apply-gain-match offscreen:", chrome.runtime.lastError.message);
    });
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "update-limiter") {
    const enabled = !!message.data?.enabled;
    chrome.runtime.sendMessage({ type: "update-limiter", data: { enabled } }, () => {
      if (chrome.runtime.lastError) warn("update-limiter offscreen:", chrome.runtime.lastError.message);
    });
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "set-bypass") {
    const enabled = !!message.data?.enabled;
    chrome.runtime.sendMessage({ type: "set-bypass", data: { enabled } }, (response) => {
      if (chrome.runtime.lastError) warn("set-bypass offscreen:", chrome.runtime.lastError.message);
      else if (response) sendResponse(response);
    });
    return true;
  }

  if (message.type === "get-bypass") {
    chrome.runtime.sendMessage({ type: "get-bypass" }, (response) => {
      if (chrome.runtime.lastError) warn("get-bypass offscreen:", chrome.runtime.lastError.message);
      sendResponse(response != null ? response : { bypassed: false });
    });
    return true;
  }

  if (message.type === "update-eq-settings") {
    const data = message.data || {};
    if (Array.isArray(data.bands) && data.bands.length > 0) {
      currentEqSettings.bands = data.bands.map((b) => ({
        frequency: typeof b.frequency === "number" ? b.frequency : 1000,
        gainDb: typeof b.gainDb === "number" ? b.gainDb : 0,
        Q: typeof b.Q === "number" ? b.Q : 1,
      }));
    }
    if (typeof data.masterGain === "number") currentEqSettings.masterGain = data.masterGain;
    saveStoredSettings();
    log("Forwarding EQ settings to offscreen.js:", currentEqSettings);
    chrome.runtime.sendMessage(
      { type: "update-eq-settings", data: currentEqSettings },
      (response) => {
        if (chrome.runtime.lastError) {
          warn("Offscreen did not receive settings:", chrome.runtime.lastError.message);
          streamInitialized = false;
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(response || { success: true });
        }
      }
    );
    return true;
  }

  if (message.type === "stop-streaming") {
    streamInitialized = false;
    lastEqSpectrum = null;
    lastEqSpectrumInput = null;
    (async () => {
      try {
        const hasOffscreen = await chrome.offscreen.hasDocument();
        if (!hasOffscreen) {
          sendResponse({ success: true });
          return;
        }
        chrome.runtime.sendMessage({ type: "stop-streaming" }, (response) => {
          if (chrome.runtime.lastError) warn("Stop-streaming offscreen error:", chrome.runtime.lastError.message);
          sendResponse(response?.success ? { success: true } : { success: false, error: "Offscreen did not confirm stop." });
        });
      } catch (err) {
        sendResponse({ success: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "get-eq-settings") {
    let responded = false;
    const reply = async () => {
      if (responded) return;
      responded = true;
      const exists = await chrome.offscreen.hasDocument();
      const streamActive = streamInitialized && exists;
      sendResponse({
        settings: {
          bands: currentEqSettings.bands.map((b) => ({ ...b })),
          masterGain: currentEqSettings.masterGain,
          smoothing: currentSmoothing,
        },
        streamActive,
      });
    };
    setTimeout(() => reply(), 250);
    loadStoredSettings().then(() => reply()).catch(() => reply());
    return true;
  }
});
