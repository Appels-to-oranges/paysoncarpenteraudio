let audioContext;
let source;
let compressor;
let gainNode;
let analyserNode;
let currentMediaStream = null;
let pendingCompressorSettings = null;
let measurementActive = false;
let measurementSamples = [];
let statsIntervalId = null;

const STATS_INTERVAL_MS = 25;
const MEASUREMENT_SILENCE_THRESHOLD_DB = -80;

function startStatsLoop() {
  if (statsIntervalId) return;
  if (!analyserNode || !compressor) return;

  const dataArray = new Float32Array(analyserNode.fftSize);
  statsIntervalId = setInterval(() => {
    try {
      analyserNode.getFloatTimeDomainData(dataArray);
      let peak = 0;
      for (let i = 0; i < dataArray.length; i += 1) {
        const abs = Math.abs(dataArray[i]);
        if (abs > peak) peak = abs;
      }
      const inputLevelDb = peak <= 0 ? -100 : Math.max(-100, 20 * Math.log10(peak));
      if (measurementActive && inputLevelDb > MEASUREMENT_SILENCE_THRESHOLD_DB) {
        measurementSamples.push(inputLevelDb);
      }
    } catch (_) {}
  }, STATS_INTERVAL_MS);
}

function stopStatsLoop() {
  if (statsIntervalId) {
    clearInterval(statsIntervalId);
    statsIntervalId = null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "process-stream") {
    const streamId = message.data?.streamId;
    if (!streamId) {
      sendResponse({ success: false, error: "Missing streamId" });
      return true;
    }

    const connectGraph = (media) => {
      if (currentMediaStream) {
        currentMediaStream.getTracks().forEach((track) => track.stop());
        currentMediaStream = null;
      }

      if (source) {
        try { source.disconnect(); } catch (_) {}
      }

      currentMediaStream = media;
      source = audioContext.createMediaStreamSource(media);
      source.connect(analyserNode);
    };

    const onReady = (media) => {
      if (audioContext && compressor && gainNode) {
        connectGraph(media);
        sendResponse({ success: true });
        return;
      }

      audioContext = new AudioContext();
      compressor = audioContext.createDynamicsCompressor();
      gainNode = audioContext.createGain();
      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 2048;
      analyserNode.smoothingTimeConstant = 0.5;
      source = audioContext.createMediaStreamSource(media);

      source.connect(analyserNode);
      analyserNode.connect(compressor);
      compressor.connect(gainNode);
      gainNode.connect(audioContext.destination);
      startStatsLoop();

      if (pendingCompressorSettings) {
        const s = pendingCompressorSettings;
        if (typeof s.threshold === "number") compressor.threshold.value = s.threshold;
        if (typeof s.ratio === "number") compressor.ratio.value = s.ratio;
        if (typeof s.attack === "number") compressor.attack.value = s.attack;
        if (typeof s.release === "number") compressor.release.value = s.release;
        if (typeof s.gain === "number") gainNode.gain.value = s.gain;
        pendingCompressorSettings = null;
      }

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
    }).then(onReady).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });

    return true;
  }

  if (message.type === "update-compressor-settings") {
    const data = message.data || {};
    if (!compressor || !gainNode) {
      pendingCompressorSettings = { ...data };
      sendResponse({ success: true });
      return true;
    }

    if (typeof data.threshold === "number") compressor.threshold.value = data.threshold;
    if (typeof data.ratio === "number") compressor.ratio.value = data.ratio;
    if (typeof data.attack === "number") compressor.attack.value = data.attack;
    if (typeof data.release === "number") compressor.release.value = data.release;
    if (typeof data.gain === "number") gainNode.gain.value = data.gain;

    sendResponse({ success: true });
    return true;
  }

  if (message.type === "start-input-measurement") {
    const durationMs = Math.max(1000, Math.min(10000, Number(message.data?.durationMs) || 3000));
    if (!analyserNode || !compressor) {
      sendResponse({ success: false, error: "No audio stream; apply capture first." });
      return true;
    }
    measurementSamples = [];
    measurementActive = true;
    sendResponse({ started: true });

    setTimeout(() => {
      measurementActive = false;
      let averageInputLevelDb = null;
      if (measurementSamples.length > 0) {
        const sum = measurementSamples.reduce((acc, value) => acc + value, 0);
        averageInputLevelDb = sum / measurementSamples.length;
      }
      chrome.runtime.sendMessage({
        type: "input-measurement-done",
        data: { averageInputLevelDb },
      });
    }, durationMs);
    return false;
  }

  if (message.type === "stop-streaming") {
    stopStatsLoop();
    measurementActive = false;
    measurementSamples = [];
    if (currentMediaStream) {
      currentMediaStream.getTracks().forEach((track) => track.stop());
      currentMediaStream = null;
    }
    if (source) {
      try { source.disconnect(); } catch (_) {}
      source = null;
    }
    if (compressor) {
      try { compressor.disconnect(); } catch (_) {}
      compressor = null;
    }
    if (analyserNode) {
      try { analyserNode.disconnect(); } catch (_) {}
      analyserNode = null;
    }
    if (gainNode) {
      try { gainNode.disconnect(); } catch (_) {}
      gainNode = null;
    }
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    pendingCompressorSettings = null;
    sendResponse({ success: true });
    return true;
  }

  return false;
});

chrome.runtime.sendMessage({ type: "offscreen-ready" });
