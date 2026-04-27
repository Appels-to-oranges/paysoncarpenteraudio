const log = (...args) => console.log("%c[offscreen.js]", "color: purple; font-weight: bold;", ...args);
const warn = (...args) => console.warn("%c[offscreen.js WARNING]", "color: orange; font-weight: bold;", ...args);
const error = (...args) => console.error("%c[offscreen.js ERROR]", "color: red; font-weight: bold;", ...args);

log("Offscreen.js initialized.");

let audioContext;
let source;
let analyserInput;
let analyserOutput;
let analyserPreLimiter;
let eqFilters = []; // BiquadFilterNode per band
let masterGainNode;
let gainMatchNode;
let limiterNode;
let limiterEnabled = false;
let bypassed = false;
let currentMediaStream = null;
let pendingEqSettings = null;
let pendingSmoothing = null;
let spectrumSmoothing = 0.3;
let spectrumBins = 128;
let statsIntervalId = null;
const STATS_INTERVAL_MS = 25;
const NUM_BANDS = 4;
const SPECTRUM_FREQ_MIN = 20;
const SPECTRUM_FREQ_MAX = 20000;

function getLogSpacedSpectrumFrom(analyser, bufferRef) {
  if (!analyser || !audioContext) return null;
  const nyquist = audioContext.sampleRate / 2;
  const binCount = analyser.frequencyBinCount;
  if (!bufferRef.current || bufferRef.current.length !== binCount) {
    bufferRef.current = new Float32Array(binCount);
  }
  analyser.getFloatFrequencyData(bufferRef.current);
  const logMin = Math.log(SPECTRUM_FREQ_MIN);
  const logMax = Math.log(SPECTRUM_FREQ_MAX);
  const bins = Math.max(32, Math.min(1024, spectrumBins));
  const out = [];
  for (let i = 0; i < bins; i++) {
    const t = (i + 0.5) / bins;
    const freq = Math.exp(logMin + t * (logMax - logMin));
    const binCenter = (freq / nyquist) * binCount;
    const halfWidth = freq < 80 ? 3 : freq < 200 ? 2 : freq < 500 ? 1 : 0.5;
    const binLo = Math.max(0, Math.floor(binCenter - halfWidth));
    const binHi = Math.min(binCount - 1, Math.ceil(binCenter + halfWidth));
    let sum = 0;
    let count = 0;
    for (let b = binLo; b <= binHi; b++) {
      const db = Math.max(-100, bufferRef.current[b]);
      const linear = Math.pow(10, db / 20);
      sum += linear;
      count++;
    }
    const avgLinear = count > 0 ? sum / count : 0;
    const db = avgLinear <= 0 ? -100 : Math.max(-100, 20 * Math.log10(avgLinear));
    out.push(db);
  }
  return out;
}

const outputBufferRef = { current: null };
const inputBufferRef = { current: null };

function getLogSpacedSpectrum() {
  return getLogSpacedSpectrumFrom(analyserOutput, outputBufferRef);
}

function getLogSpacedSpectrumInput() {
  return getLogSpacedSpectrumFrom(analyserInput, inputBufferRef);
}

function startStatsLoop() {
  if (statsIntervalId) return;
  if (!audioContext || !analyserInput || !analyserOutput) return;
  const inputArray = new Float32Array(analyserInput.fftSize);
  const outputArray = new Float32Array(analyserOutput.fftSize);
  const preLimiterArray = analyserPreLimiter ? new Float32Array(analyserPreLimiter.fftSize) : null;

  statsIntervalId = setInterval(() => {
    try {
      analyserInput.getFloatTimeDomainData(inputArray);
      analyserOutput.getFloatTimeDomainData(outputArray);
      let peakIn = 0, peakOut = 0, peakPreLimiter = 0;
      for (let i = 0; i < inputArray.length; i++) {
        const a = Math.abs(inputArray[i]);
        if (a > peakIn) peakIn = a;
      }
      for (let i = 0; i < outputArray.length; i++) {
        const a = Math.abs(outputArray[i]);
        if (a > peakOut) peakOut = a;
      }
      if (analyserPreLimiter && preLimiterArray) {
        analyserPreLimiter.getFloatTimeDomainData(preLimiterArray);
        for (let i = 0; i < preLimiterArray.length; i++) {
          const a = Math.abs(preLimiterArray[i]);
          if (a > peakPreLimiter) peakPreLimiter = a;
        }
      }
      const inputLevelDb = peakIn <= 0 ? -100 : Math.max(-100, 20 * Math.log10(peakIn));
      const outputLevelDb = peakOut <= 0 ? -100 : Math.max(-100, 20 * Math.log10(peakOut));
      const preLimiterLevelDb = peakPreLimiter <= 0 ? -100 : Math.max(-100, 20 * Math.log10(peakPreLimiter));
      chrome.runtime.sendMessage({
        type: "eq-stats",
        data: { inputLevelDb, outputLevelDb, preLimiterLevelDb },
      });
      const spectrum = getLogSpacedSpectrum();
      const spectrumInput = getLogSpacedSpectrumInput();
      if (spectrum && spectrum.length > 0) {
        chrome.runtime.sendMessage({
          type: "eq-spectrum",
          data: { spectrumDb: spectrum, spectrumInputDb: spectrumInput },
        });
      }
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

function applyEqSettings(settings) {
  const bands = settings?.bands;
  const masterGain = typeof settings?.masterGain === "number" ? settings.masterGain : 1;
  if (!bands || bands.length === 0) return;

  for (let i = 0; i < Math.min(bands.length, eqFilters.length); i++) {
    const f = eqFilters[i];
    const b = bands[i];
    if (!f || !b) continue;
    f.type = "peaking";
    f.frequency.value = Math.max(10, Math.min(24000, Number(b.frequency) || 1000));
    f.gain.value = Math.max(-24, Math.min(24, Number(b.gainDb) || 0));
    f.Q.value = Math.max(0.1, Math.min(20, Number(b.Q) || 1));
  }
  if (masterGainNode) masterGainNode.gain.value = Math.max(0, Math.min(4, masterGain));
}

function buildEqChain(media, settings) {
  if (audioContext && eqFilters.length > 0) {
    // Reuse existing context and filters (chain to destination already connected)
    source = audioContext.createMediaStreamSource(media);
    source.connect(analyserInput);
    analyserInput.connect(eqFilters[0]);
    applyEqSettings(settings);
    startStatsLoop();
    return;
  }

  audioContext = new AudioContext();
  source = audioContext.createMediaStreamSource(media);
  const smooth = pendingSmoothing != null ? pendingSmoothing : spectrumSmoothing;
  analyserInput = audioContext.createAnalyser();
  analyserInput.fftSize = 8192;
  analyserInput.smoothingTimeConstant = smooth;
  analyserOutput = audioContext.createAnalyser();
  analyserOutput.fftSize = 8192;
  analyserOutput.smoothingTimeConstant = smooth;
  pendingSmoothing = null;

  eqFilters = [];
  for (let i = 0; i < NUM_BANDS; i++) {
    const filter = audioContext.createBiquadFilter();
    filter.type = "peaking";
    eqFilters.push(filter);
  }
  masterGainNode = audioContext.createGain();
  gainMatchNode = audioContext.createGain();
  gainMatchNode.gain.value = 1;
  limiterNode = audioContext.createDynamicsCompressor();
  limiterNode.threshold.value = -100;
  limiterNode.knee.value = 0;
  limiterNode.ratio.value = 1;
  limiterNode.attack.value = 0.003;
  limiterNode.release.value = 0.25;

  source.connect(analyserInput);
  analyserInput.connect(eqFilters[0]);
  for (let i = 0; i < eqFilters.length - 1; i++) {
    eqFilters[i].connect(eqFilters[i + 1]);
  }
  eqFilters[eqFilters.length - 1].connect(masterGainNode);
  masterGainNode.connect(gainMatchNode);
  analyserPreLimiter = audioContext.createAnalyser();
  analyserPreLimiter.fftSize = 2048;
  analyserPreLimiter.smoothingTimeConstant = 0;
  gainMatchNode.connect(analyserPreLimiter);
  analyserPreLimiter.connect(limiterNode);
  limiterNode.connect(analyserOutput);
  analyserOutput.connect(audioContext.destination);

  applyEqSettings(settings);
  startStatsLoop();
  log("EQ chain built. Parametric EQ ready.");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log("Message received in offscreen.js:", message.type);

  if (message.type === "process-stream") {
    const data = message.data || {};
    const { streamId } = data;
    const s = data.smoothing;
    if (typeof s === "number" && s >= 0 && s <= 1) pendingSmoothing = s;
    if (!streamId) {
      sendResponse({ success: false, error: "Missing streamId" });
      return true;
    }
    log("Accessing media stream with streamId:", streamId);

    if (currentMediaStream) {
      currentMediaStream.getTracks().forEach((t) => t.stop());
      currentMediaStream = null;
    }
    if (source) {
      try { source.disconnect(); } catch (_) {}
      source = null;
    }

    const onStreamReady = (media) => {
      log("Media stream accessed.");
      currentMediaStream = media;
      const settings = pendingEqSettings || {
        bands: Array.from({ length: NUM_BANDS }, (_, i) => ({
          frequency: [50, 100, 200, 2000][i] || 1000,
          gainDb: 0,
          Q: 1,
        })),
        masterGain: 1,
      };
      buildEqChain(media, settings);
      pendingEqSettings = null;
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
      error("getUserMedia error:", err);
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.type === "update-smoothing") {
    const value = message.data?.value;
    const num = typeof value === "number" ? Math.max(0, Math.min(1, value)) : 0.5;
    spectrumSmoothing = num;
    if (analyserInput) analyserInput.smoothingTimeConstant = num;
    if (analyserOutput) analyserOutput.smoothingTimeConstant = num;
    if (!analyserInput && !analyserOutput) pendingSmoothing = num;
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "update-spectrum-bins") {
    const value = message.data?.value;
    const bins = typeof value === "number" ? Math.max(32, Math.min(1024, value)) : 128;
    spectrumBins = bins;
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "apply-gain-match") {
    const gainMatchDb = message.data?.gainMatchDb;
    if (typeof gainMatchDb === "number" && gainMatchNode) {
      const db = Math.round(gainMatchDb * 10) / 10;
      const linear = Math.pow(10, Math.max(-40, Math.min(20, db)) / 20);
      gainMatchNode.gain.value = Math.max(0.1, Math.min(10, linear));
    }
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "update-limiter") {
    limiterEnabled = !!message.data?.enabled;
    if (limiterNode) {
      limiterNode.threshold.value = limiterEnabled ? -1 : -100;
      limiterNode.ratio.value = limiterEnabled ? 20 : 1;
    }
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "set-bypass") {
    const enable = !!message.data?.enabled;
    if (enable !== bypassed && source && limiterNode && audioContext) {
      try {
        if (enable) {
          limiterNode.disconnect();
          source.connect(audioContext.destination);
        } else {
          source.disconnect(audioContext.destination);
          limiterNode.connect(analyserOutput);
        }
        bypassed = enable;
      } catch (e) {
        warn("Bypass toggle error:", e);
      }
    } else if (enable !== bypassed) {
      bypassed = enable;
    }
    sendResponse({ success: true, bypassed });
    return true;
  }

  if (message.type === "get-bypass") {
    sendResponse({ bypassed });
    return true;
  }

  if (message.type === "update-eq-settings") {
    const data = message.data || {};
    const settings = {
      bands: Array.isArray(data.bands) ? data.bands : [],
      masterGain: typeof data.masterGain === "number" ? data.masterGain : 1,
    };
    if (eqFilters.length === 0) {
      pendingEqSettings = settings;
      log("EQ not ready yet; stored pending settings.");
      sendResponse({ success: true });
      return true;
    }
    log("Updating EQ settings:", settings);
    applyEqSettings(settings);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "stop-streaming") {
    stopStatsLoop();
    if (currentMediaStream) {
      currentMediaStream.getTracks().forEach((t) => t.stop());
      currentMediaStream = null;
      log("Media stream tracks stopped.");
    }
    if (source) {
      try {
        if (bypassed && audioContext) source.disconnect(audioContext.destination);
      } catch (_) {}
      try { source.disconnect(); } catch (_) {}
      source = null;
    }
    bypassed = false;
    if (analyserInput) {
      try { analyserInput.disconnect(); } catch (_) {}
      analyserInput = null;
    }
    if (analyserOutput) {
      try { analyserOutput.disconnect(); } catch (_) {}
      analyserOutput = null;
    }
    if (analyserPreLimiter) {
      try { analyserPreLimiter.disconnect(); } catch (_) {}
      analyserPreLimiter = null;
    }
    if (gainMatchNode) {
      try { gainMatchNode.disconnect(); } catch (_) {}
      gainMatchNode = null;
    }
    if (limiterNode) {
      try { limiterNode.disconnect(); } catch (_) {}
      limiterNode = null;
    }
    eqFilters.forEach((f) => {
      try { f.disconnect(); } catch (_) {}
    });
    eqFilters = [];
    if (masterGainNode) {
      try { masterGainNode.disconnect(); } catch (_) {}
      masterGainNode = null;
    }
    if (audioContext) {
      audioContext.close().then(() => log("AudioContext closed.")).catch((e) => warn("AudioContext close error:", e));
      audioContext = null;
    }
    pendingEqSettings = null;
    log("Stream and EQ stopped.");
    sendResponse({ success: true });
    return true;
  }

  warn("Unknown message type in offscreen.js:", message.type);
  return false;
});

chrome.runtime.sendMessage({ type: "offscreen-ready" });
log("Offscreen.js loaded and reported ready.");
