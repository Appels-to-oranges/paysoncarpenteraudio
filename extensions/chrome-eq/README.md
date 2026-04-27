# ChromeEQ

Parametric graphic EQ Chrome extension. Same architecture as Chromepressor: tab capture, offscreen document for Web Audio, popup UI, and persistent storage.

## Features

- **4-band parametric EQ**: each band has Frequency (20 Hz–20 kHz), Gain (-12 to +12 dB), and Q (0.3–8).
- **Master gain**: 0.25× to 2×.
- **Input / output level** readouts and optional level chart in Settings.
- **Log-frequency spectrum** visualization with configurable smoothing and bin count.
- **Limiter**, **bypass**, and **gain match** controls.
- **Reset to flat**: set all band gains to 0 dB.
- Settings (including band state) are saved and restored.

## Load in Chrome

1. Add PNG icons in `icons/`: `icon16.png`, `icon48.png`, `icon128.png` (or copy from Chromepressor).
2. Open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select the `ChromeEQ` folder.

## Architecture (mirrors Chromepressor)

- **manifest.json** – MV3, offscreen, tabCapture, storage.
- **background.js** – Service worker: creates offscreen document, handles tab capture and stream ID, stores/forwards EQ settings, routes messages (start/stop streaming, update-eq-settings, get-eq-settings, get-eq-stats).
- **offscreen.html / offscreen.js** – Gets tab audio via `getUserMedia` + `chromeMediaSourceId`, builds chain: `MediaStreamSource → Analyser (input) → BiquadFilter × 4 (peaking) → Gain → Analyser (pre-limiter) → DynamicsCompressor (limiter) → Analyser (output) → destination`. Sends input/output level to background for popup meters.
- **popup.html / popup.js** – Main view: master gain + 4 bands (freq, gain, Q), input/output level, spectrum chart, Reset to flat, Stop capture, Settings. Settings view: level meters, spectrum config, limiter/bypass/gain-match toggles. All slider changes send `update-eq-settings`; opening the popup triggers `start-streaming` for the active tab.

## Default bands (Hz)

50, 100, 200, 2000 — all 0 dB, Q 1 (flat until you change them).
