const log = (...args) => console.log("%c[background.js]", "color: green; font-weight: bold;", ...args);
const warn = (...args) => console.warn("%c[background.js WARNING]", "color: orange; font-weight: bold;", ...args);
const error = (...args) => console.error("%c[background.js ERROR]", "color: red; font-weight: bold;", ...args);

let streamInitialized = false;
let offscreenReady = false;
let popupPort = null;
let lastCompressorStats = { inputLevelDb: null, gainReductionDb: null };
let pendingMeasurementSendResponse = null;

const STORAGE_KEY = "compressorSettings";
const DEFAULT_COMPRESSOR_SETTINGS = {
  threshold: -24,
  ratio: 18,
  attack: 0.001,
  release: 0.01,
  gain: 1,
};
let currentCompressorSettings = { ...DEFAULT_COMPRESSOR_SETTINGS };

function loadStoredSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      if (result[STORAGE_KEY] && typeof result[STORAGE_KEY] === "object") {
        currentCompressorSettings = { ...DEFAULT_COMPRESSOR_SETTINGS, ...result[STORAGE_KEY] };
        log("Loaded compressor settings from storage:", currentCompressorSettings);
      }
      resolve();
    });
  });
}

function saveStoredSettings() {
  chrome.storage.local.set({ [STORAGE_KEY]: currentCompressorSettings });
}

loadStoredSettings();


async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  log("Checking offscreen document status:", existing);

  if (!existing) {
    try {
      log("Creating offscreen document...");
      log("Offscreen doc URL:", chrome.runtime.getURL("offscreen.html"));
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL("offscreen.html"),
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Required for audio compression.",
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
  log("Message received in background.js:", message);

  // Offscreen signals it's ready
  if (message.type === "offscreen-ready") {
    log("Offscreen document reports READY.");
    offscreenReady = true;
    return;
  }

  // Offscreen sends live compressor stats (input level, gain reduction)
  if (message.type === "compressor-stats") {
    const data = message.data || {};
    lastCompressorStats = {
      inputLevelDb: typeof data.inputLevelDb === "number" ? data.inputLevelDb : null,
      gainReductionDb: typeof data.gainReductionDb === "number" ? data.gainReductionDb : null,
    };
    if (popupPort?.name === "popup-control") {
      try {
        popupPort.postMessage({ type: "compressor-stats", data: lastCompressorStats });
      } catch (_) {}
    }
    return;
  }

  // Popup requests latest compressor stats for display
  if (message.type === "get-compressor-stats") {
    sendResponse(lastCompressorStats);
    return true;
  }

  // Popup requests measure-input-level: measure for a few seconds, then respond with average (async)
  if (message.type === "measure-input-level") {
    const durationMs = Math.max(1000, Math.min(10000, Number(message.data?.durationMs) || 3000));
    pendingMeasurementSendResponse = sendResponse;
    chrome.runtime.sendMessage(
      { type: "start-input-measurement", data: { durationMs } },
      (response) => {
        if (chrome.runtime.lastError || !response?.started) {
          if (pendingMeasurementSendResponse) {
            pendingMeasurementSendResponse({
              success: false,
              error: chrome.runtime.lastError?.message || "Measurement could not start.",
            });
            pendingMeasurementSendResponse = null;
          }
        }
      }
    );
    return true;
  }

  // Offscreen reports input measurement complete; reply to waiting popup
  if (message.type === "input-measurement-done") {
    const data = message.data || {};
    const averageInputLevelDb = typeof data.averageInputLevelDb === "number" ? data.averageInputLevelDb : null;
    if (pendingMeasurementSendResponse) {
      if (averageInputLevelDb == null) {
        pendingMeasurementSendResponse({
          success: false,
          error: "No audible signal during measurement. Play audio and try again.",
        });
      } else {
        pendingMeasurementSendResponse({ success: true, averageInputLevelDb });
      }
      pendingMeasurementSendResponse = null;
    }
    return false;
  }

  // Popup checking if offscreen exists (IMPORTANT FIX!)
  if (message.type === "check-offscreen") {
    chrome.offscreen.hasDocument((exists) => {
      log("Popup check-offscreen request - Exists:", exists, "Ready flag:", offscreenReady);
      sendResponse({ ready: exists });
    });
    return true; // CRUCIAL to keep port open!
  }

  // Start streaming: popup sends targetTabId; we use getCapturedTabs() to avoid getMediaStreamId when tab already captured
  if (message.type === "start-streaming") {
    (async () => {
      try {
        const targetTabId = message.data?.targetTabId;
        if (targetTabId == null) {
          sendResponse({ success: false, error: "Missing targetTabId" });
          return;
        }

        const exists = await chrome.offscreen.hasDocument();
        if (!exists) {
          streamInitialized = false;
        }

        let alreadyCaptured = false;
        try {
          const captured = await chrome.tabCapture.getCapturedTabs();
          alreadyCaptured = captured.some((info) => info.tabId === targetTabId && info.status === "active");
          log("getCapturedTabs:", captured, "alreadyCaptured:", alreadyCaptured);
        } catch (e) {
          log("getCapturedTabs failed:", e);
        }

        if (alreadyCaptured) {
          log("Tab already captured (active stream); skipping getMediaStreamId, applying settings only.");
          await ensureOffscreen();
          streamInitialized = true;
          sendResponse({ success: true });
          const toSend = { ...DEFAULT_COMPRESSOR_SETTINGS, ...currentCompressorSettings };
          chrome.runtime.sendMessage({ type: "update-compressor-settings", data: toSend });
          return;
        }

        log("Obtaining stream ID for tab", targetTabId, "(service worker; no consumerTabId so offscreen can consume).");
        let streamId;
        try {
          streamId = await chrome.tabCapture.getMediaStreamId({
            targetTabId,
          });
        } catch (err) {
          error("getMediaStreamId failed:", err);
          sendResponse({ success: false, error: err?.message || String(err) });
          return;
        }

        await ensureOffscreen();
        log("Forwarding process-stream to offscreen.js");

        chrome.runtime.sendMessage(
          { type: "process-stream", data: { streamId } },
          (response) => {
            log("Received response from offscreen.js:", response);
            if (response?.success) {
              log("Streaming successfully started.");
              streamInitialized = true;
              sendResponse({ success: true });
              const toSend = { ...DEFAULT_COMPRESSOR_SETTINGS, ...currentCompressorSettings };
              chrome.runtime.sendMessage({
                type: "update-compressor-settings",
                data: toSend,
              });
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

    return true; // Important async port hold
  }

  // Forward compressor settings to offscreen and relay response back to popup
  if (message.type === "update-compressor-settings") {
    currentCompressorSettings = { ...DEFAULT_COMPRESSOR_SETTINGS, ...message.data };
    saveStoredSettings();
    log("Forwarding compressor settings to offscreen.js:", currentCompressorSettings);
    chrome.runtime.sendMessage(
      { type: "update-compressor-settings", data: currentCompressorSettings },
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

  // Stop streaming: close mediastream and cease all compression/audio manipulation
  if (message.type === "stop-streaming") {
    streamInitialized = false;
    (async () => {
      try {
        const hasOffscreen = await chrome.offscreen.hasDocument();
        if (!hasOffscreen) {
          sendResponse({ success: true });
          return;
        }
        chrome.runtime.sendMessage({ type: "stop-streaming" }, (response) => {
          if (chrome.runtime.lastError) {
            warn("Stop-streaming offscreen error:", chrome.runtime.lastError.message);
          }
          sendResponse(response && response.success ? { success: true } : { success: false, error: "Offscreen did not confirm stop." });
        });
      } catch (err) {
        sendResponse({ success: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "get-compressor-settings") {
    let responded = false;
    const reply = async () => {
      if (responded) return;
      responded = true;
      const exists = await chrome.offscreen.hasDocument();
      const streamActive = streamInitialized && exists;
      sendResponse({
        settings: { ...DEFAULT_COMPRESSOR_SETTINGS, ...currentCompressorSettings },
        streamActive,
      });
    };
    setTimeout(() => reply(), 250);
    loadStoredSettings().then(() => reply()).catch(() => reply());
    return true;
  }
});
