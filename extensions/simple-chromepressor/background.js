let streamInitialized = false;
let offscreenReady = false;
let pendingMeasurementSendResponse = null;

const STORAGE_KEY = "compressorSettings";
const DEFAULT_COMPRESSOR_SETTINGS = {
  threshold: -24,
  ratio: 20,
  attack: 0.001,
  release: 0.01,
  gain: 1.1,
};

let currentCompressorSettings = { ...DEFAULT_COMPRESSOR_SETTINGS };

function loadStoredSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      if (result[STORAGE_KEY] && typeof result[STORAGE_KEY] === "object") {
        currentCompressorSettings = { ...DEFAULT_COMPRESSOR_SETTINGS, ...result[STORAGE_KEY] };
      }
      resolve();
    });
  });
}

function saveStoredSettings() {
  chrome.storage.local.set({ [STORAGE_KEY]: currentCompressorSettings });
}

loadStoredSettings();

async function waitForOffscreenReadySignal(timeoutMs = 10000) {
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

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("offscreen.html"),
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Required for audio compression.",
    });
    await waitForOffscreenReadySignal();
  } else if (!offscreenReady) {
    await waitForOffscreenReadySignal(2000);
    offscreenReady = true;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "offscreen-ready") {
    offscreenReady = true;
    return;
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
        } catch (_) {}

        if (alreadyCaptured) {
          await ensureOffscreen();
          streamInitialized = true;
          sendResponse({ success: true });
          chrome.runtime.sendMessage({ type: "update-compressor-settings", data: currentCompressorSettings });
          return;
        }

        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId });
        await ensureOffscreen();

        chrome.runtime.sendMessage({ type: "process-stream", data: { streamId } }, (response) => {
          if (response?.success) {
            streamInitialized = true;
            sendResponse({ success: true });
            chrome.runtime.sendMessage({ type: "update-compressor-settings", data: currentCompressorSettings });
          } else {
            sendResponse({ success: false, error: "Failed in offscreen document." });
          }
        });
      } catch (err) {
        sendResponse({ success: false, error: err?.message || String(err) });
      }
    })();

    return true;
  }

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

  if (message.type === "update-compressor-settings") {
    currentCompressorSettings = { ...DEFAULT_COMPRESSOR_SETTINGS, ...message.data };
    saveStoredSettings();

    chrome.runtime.sendMessage({ type: "update-compressor-settings", data: currentCompressorSettings }, (response) => {
      if (chrome.runtime.lastError) {
        streamInitialized = false;
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse(response || { success: true });
      }
    });
    return true;
  }

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
