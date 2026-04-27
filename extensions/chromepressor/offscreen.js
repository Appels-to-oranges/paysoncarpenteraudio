const log = (...args) => console.log("%c[offscreen.js]", "color: purple; font-weight: bold;", ...args);
const warn = (...args) => console.warn("%c[offscreen.js WARNING]", "color: orange; font-weight: bold;", ...args);
const error = (...args) => console.error("%c[offscreen.js ERROR]", "color: red; font-weight: bold;", ...args);

log("Offscreen.js initialized.");

let audioContext;
let source;
let analyserNode;
let compressor;
let gainNode;
let currentMediaStream = null; // so we can stop tracks when stopping capture
let pendingCompressorSettings = null;
let statsIntervalId = null;
const STATS_INTERVAL_MS = 25;

/** Scale applied gain down as ratio increases so ratio 10 doesn't add too much level. */
function gainScaleForRatio(ratio) {
  if (ratio <= 2) return 1;
  return 1 / Math.pow(ratio / 2, 0.4); // ratio 2 → 1, ratio 10 → ~0.53, ratio 20 → ~0.4
}

let measurementSamples = [];
let measurementActive = false;
const MEASUREMENT_SILENCE_THRESHOLD_DB = -80;

function startStatsLoop() {
  if (statsIntervalId) return;
  if (!audioContext || !analyserNode || !compressor) return;
  const bufferLength = analyserNode.frequencyBinCount;
  const dataArray = new Float32Array(analyserNode.fftSize);

  statsIntervalId = setInterval(() => {
    try {
      analyserNode.getFloatTimeDomainData(dataArray);
      let peak = 0;
      for (let i = 0; i < bufferLength; i++) {
        const abs = Math.abs(dataArray[i]);
        if (abs > peak) peak = abs;
      }
      const inputLevelDb = peak <= 0 ? -100 : Math.max(-100, 20 * Math.log10(peak));
      const gainReductionDb = compressor.reduction;
      if (measurementActive) {
        if (inputLevelDb > MEASUREMENT_SILENCE_THRESHOLD_DB) {
          measurementSamples.push(inputLevelDb);
        }
      }
      chrome.runtime.sendMessage({
        type: "compressor-stats",
        data: { inputLevelDb, gainReductionDb },
      });
    } catch (e) {
      warn("Stats loop error:", e);
    }
  }, STATS_INTERVAL_MS);
  log("Stats loop started.");
}

function stopStatsLoop() {
  if (statsIntervalId) {
    clearInterval(statsIntervalId);
    statsIntervalId = null;
    log("Stats loop stopped.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log("Message received in offscreen.js:", message);

  if (message.type === "process-stream") {
    const { streamId } = message.data || {};
    if (!streamId) {
      sendResponse({ success: false, error: "Missing streamId" });
      return true;
    }
    log("Attempting to access media stream with streamId:", streamId);

    const connectNewStream = (media) => {
      if (currentMediaStream) {
        currentMediaStream.getTracks().forEach((t) => t.stop());
        currentMediaStream = null;
      }
      if (source) {
        try { source.disconnect(); } catch (_) {}
        source = null;
      }
      currentMediaStream = media;
      source = audioContext.createMediaStreamSource(media);
      source.connect(analyserNode);
      log("New stream connected to existing compressor graph.");
      startStatsLoop();
    };

    const onStreamReady = (media) => {
      log("Media stream successfully accessed.");
      currentMediaStream = media;
      if (audioContext && compressor && gainNode) {
        connectNewStream(media);
        sendResponse({ success: true });
        return;
      }
      audioContext = new AudioContext();
      source = audioContext.createMediaStreamSource(media);
      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 2048;
      analyserNode.smoothingTimeConstant = 0.5;
      compressor = audioContext.createDynamicsCompressor();
      gainNode = audioContext.createGain();
      source.connect(analyserNode);
      analyserNode.connect(compressor);
      compressor.connect(gainNode);
      gainNode.connect(audioContext.destination);
      startStatsLoop();
      if (pendingCompressorSettings) {
        const d = pendingCompressorSettings;
        if (typeof d.threshold === "number") compressor.threshold.value = d.threshold;
        if (typeof d.ratio === "number") compressor.ratio.value = d.ratio;
        if (typeof d.attack === "number") compressor.attack.value = d.attack;
        if (typeof d.release === "number") compressor.release.value = d.release;
        if (typeof d.gain === "number") gainNode.gain.value = d.gain * gainScaleForRatio(d.ratio ?? 2);
        log("Applied pending compressor settings:", pendingCompressorSettings);
        pendingCompressorSettings = null;
      }
      log("Audio nodes connected. Compression ready.");
      sendResponse({ success: true });
    };

    navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    }).then(onStreamReady).catch((err) => {
      error("getUserMedia threw error:", err);
      sendResponse({ success: false, error: err.message });
    });

    return true;
  }

  if (message.type === "update-compressor-settings") {
    const data = message.data || {};
    const apply = (c, g) => {
      if (typeof data.threshold === "number") c.threshold.value = data.threshold;
      if (typeof data.ratio === "number") c.ratio.value = data.ratio;
      if (typeof data.attack === "number") c.attack.value = data.attack;
      if (typeof data.release === "number") c.release.value = data.release;
      if (typeof data.gain === "number") g.gain.value = data.gain * gainScaleForRatio(data.ratio ?? 2);
    };
    if (!compressor || !gainNode) {
      pendingCompressorSettings = { ...data };
      log("Compressor not ready yet; stored pending settings:", pendingCompressorSettings);
      sendResponse({ success: true });
      return true;
    }

    log("Updating compressor settings:", data);
    apply(compressor, gainNode);
    log("Compressor settings applied successfully.");
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "stop-streaming") {
    stopStatsLoop();
    measurementActive = false;
    measurementSamples = [];
    if (currentMediaStream) {
      currentMediaStream.getTracks().forEach((t) => t.stop());
      currentMediaStream = null;
      log("Media stream tracks stopped.");
    }
    if (source) {
      try { source.disconnect(); } catch (_) {}
      source = null;
    }
    if (analyserNode) {
      try { analyserNode.disconnect(); } catch (_) {}
      analyserNode = null;
    }
    if (compressor) {
      try { compressor.disconnect(); } catch (_) {}
      compressor = null;
    }
    if (gainNode) {
      try { gainNode.disconnect(); } catch (_) {}
      gainNode = null;
    }
    if (audioContext) {
      audioContext.close().then(() => log("AudioContext closed.")).catch((e) => warn("AudioContext close error:", e));
      audioContext = null;
    }
    pendingCompressorSettings = null;
    log("Stream and compression stopped.");
    sendResponse({ success: true });
    return true;
  }

  // Intended for background only; ignore here so background can respond
  if (message.type === "get-compressor-stats" || message.type === "measure-input-level" || message.type === "start-streaming") {
    return false;
  }

  if (message.type === "start-input-measurement") {
    const durationMs = Math.max(1000, Math.min(10000, Number(message.data?.durationMs) || 3000));
    if (!analyserNode || !compressor) {
      sendResponse({ success: false, error: "No audio stream; apply capture first." });
      return true;
    }
    measurementSamples = [];
    measurementActive = true;
    log("Input measurement started for", durationMs, "ms.");
    sendResponse({ started: true });

    setTimeout(() => {
      measurementActive = false;
      let averageInputLevelDb = null;
      if (measurementSamples.length > 0) {
        const sum = measurementSamples.reduce((a, b) => a + b, 0);
        averageInputLevelDb = sum / measurementSamples.length;
      }
      log("Input measurement done. Samples:", measurementSamples.length, "Average (dB):", averageInputLevelDb);
      chrome.runtime.sendMessage({
        type: "input-measurement-done",
        data: { averageInputLevelDb },
      });
    }, durationMs);
    return false;
  }

  warn("Unknown message type received in offscreen.js:", message.type);
  return false;
});

chrome.runtime.sendMessage({ type: "offscreen-ready" });
log("Offscreen.js fully loaded and reported ready.");
