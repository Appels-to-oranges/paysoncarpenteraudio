# Payson Carpenter Audio

Audio tools and products: Chrome extensions for real-time tab audio processing, Max for Live devices, and the product site at [paysoncarpenteraudio.com](https://paysoncarpenteraudio.com).

## Structure

```
├── src/                    # Astro site source
├── public/                 # Static site assets
├── extensions/
│   ├── chrome-eq/          # Parametric EQ Chrome extension (MV3)
│   ├── chromepressor/      # Dynamic compressor Chrome extension (MV3)
│   └── simple-chromepressor/ # Stripped-down compressor variant
├── max-for-live/
│   ├── Harmonic Calculator.amxd
│   └── gyro_lfo.maxpat
├── Dockerfile              # Multi-stage build (Node → nginx)
└── scripts/                # Asset generation tooling
```

## Extensions

All extensions use the same Chrome MV3 architecture: service worker for tab capture, offscreen document for Web Audio processing, popup UI for controls.

- **ChromeEQ** — 4-band parametric EQ with spectrum visualization, limiter, bypass, and gain match
- **Chromepressor** — Dynamic range compressor with threshold, ratio, attack, release, makeup gain, and peak metering
- **SimpleChromepressor** — Lightweight compressor variant with fewer controls

See each extension's folder for its own README and manifest.

## Site

The marketing site is built with Astro 5 and deployed via Docker + nginx.

```
npm install
npm run dev
```

## Max for Live

- **Harmonic Calculator** — Utility device for harmonic series exploration
- **Gyro LFO** — LFO device with gyroscope input
