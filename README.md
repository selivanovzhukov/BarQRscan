# bar-qr-scan

High-performance, zero-dependency universal 1D barcode and QR scanner SDK for modern Web applications.

Works seamlessly across:
- **Android (Chrome, Samsung Internet, Firefox)**: Hardware-accelerated BarcodeDetector (Google ML Kit) with automatic runtime self-healing failover to ZXing-C++ WASM.
- **iOS (iPhone & iPad Safari)**: High-speed C++20 ZXing-WASM with horizontal Clean 1D Strip and 24px white quiet-zone padding (15-28 ms per frame).
- **Windows & macOS Laptops**: Built-in fixed-focus and USB webcams supported through a dual-scale QR detector (Macro 1:1 center crop + contrast Auto-Levels).
- **Smart Camera Management**: Automatically filters out selfie cameras on smartphones and picks the rear camera supporting flashlight/macro.

---

## Supported Formats

- **1D Barcodes**: `Code-128`, `EAN-13`, `EAN-8`, `UPC-A`, `UPC-E`, `Code-39`, `ITF`
- **2D Codes**: `QR Code`

---

## Installation

```bash
npm install bar-qr-scan
```

Or via CDN / direct ESM import:

```html
<script type="module">
  import { BarQRScanner } from 'https://cdn.jsdelivr.net/npm/bar-qr-scan/barcode-scanner.js';
</script>
```

---

## Quick Start (One-Line UI Widget)

Mount a complete scanner widget with a responsive viewport, target reticle, zoom slider (1.0x - 3.0x), and camera controls:

```html
<div id="scanner-container"></div>

<script type="module">
  import { BarQRScanner } from 'bar-qr-scan';

  const scanner = await BarQRScanner.mount('#scanner-container', {
    duplicateCooldownMs: 1500,
    onScan: ({ value, format, engine, elapsedMs }) => {
      console.log(`Scanned: ${value} (${format}) in ${elapsedMs}ms [${engine}]`);
    }
  });

  // When finished:
  // scanner.destroy();
</script>
```

---

## Headless API (Custom UI)

Bind the scanner engine to your own `<video>` element and design your own buttons:

```html
<video id="camera-stream" playsinline autoplay muted></video>
<button id="btn-switch">Switch Camera</button>
<button id="btn-reset">Reset</button>
<button id="btn-torch">Torch</button>

<script type="module">
  import { BarQRScanner } from 'bar-qr-scan';

  const scanner = new BarQRScanner({
    videoElement: document.getElementById('camera-stream'),
    confirmFrames: 2,          // 1 frame for QR / checksum Code-128; 2 frames for retail EAN
    duplicateCooldownMs: 2000, // Cooldown in ms between duplicate reads
    beepOnScan: true,
    vibrateOnScan: true,
    onScan: ({ value, format, engine, elapsedMs }) => {
      console.log('Result:', value, format, elapsedMs);
    },
    onStatus: (msg) => console.info('[Scanner Status]', msg),
    onError: (err) => console.error('[Scanner Error]', err)
  });

  // Start scanning (auto-selects best rear camera with torch support)
  const info = await scanner.start();
  console.log('Engine:', info.engine, 'Torch supported:', Boolean(info.capabilities.torch));

  // Controls:
  document.getElementById('btn-switch').onclick = () => scanner.switchRearCamera();
  document.getElementById('btn-reset').onclick = () => scanner.refreshCamera();
  document.getElementById('btn-torch').onclick = () => scanner.setTorch(!scanner.torchEnabled);
</script>
```

---

## React / Next.js Integration

```tsx
import React, { useEffect, useRef } from 'react';
import { BarQRScanner, ScanResult } from 'bar-qr-scan';

interface Props {
  onDetected: (result: ScanResult) => void;
}

export const BarcodeScannerModal: React.FC<Props> = ({ onDetected }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let scanner: BarQRScanner | null = null;

    if (containerRef.current) {
      BarQRScanner.mount(containerRef.current, {
        onScan: onDetected
      }).then((instance) => {
        scanner = instance;
      });
    }

    return () => {
      if (scanner) scanner.destroy();
    };
  }, [onDetected]);

  return <div ref={containerRef} style={{ width: '100%', maxWidth: '480px' }} />;
};
```

---

## Configuration Options

| Option | Type | Default | Description |
|---|---|---|---|
| `videoElement` | `HTMLVideoElement` | `null` | Target video element (required for Headless mode). |
| `onScan` | `function` | `()` | Callback invoked with `{ value, format, engine, elapsedMs }`. |
| `onError` | `function` | `console.error` | Error handler callback. |
| `onStatus` | `function` | `console.log` | Diagnostic status updates (e.g. engine switches). |
| `formats` | `Array` | All formats | Array of formats: `'code_128'`, `'ean_13'`, `'qr_code'`, etc. |
| `confirmFrames` | `number` | `2` | Required consecutive matching frames (1 for QR and Code-128). |
| `duplicateCooldownMs`| `number` | `2000` | Minimum delay before re-scanning the same code (in ms). |
| `beepOnScan` | `boolean` | `true` | Audio confirmation on detection (set `false` to mute). |
| `sound` | `string \| object \| function` | `'pos'` | Sound preset (`'pos'`, `'chirp'`, `'industrial'`, `'bell'`, `'double'`, `'chord'`), synthesis config object, audio URL, or custom generator callback. |
| `vibrateOnScan` | `boolean` | `true` | Triggers a 50 ms haptic pulse on mobile devices. |
| `roi` | `object` | `{ widthRatio: 0.94, heightRatio: 0.42 }` | Crop region for performance and aiming. |
| `forceWasm` | `boolean` | `false` | Force ZXing-C++ WASM even if native BarcodeDetector exists. |
| `wasmIifeUrl` | `string` | jsDelivr CDN | Custom URL to the zxing-wasm IIFE script bundle. |
| `wasmBinaryDir` | `string` | jsDelivr CDN | Custom directory containing the `zxing_reader.wasm` binary. |

---

## Sound Customization

The scanner provides 3 ways to tailor audio confirmation:

### 1. Built-in Sound Presets
Choose from presets tuned for different use cases:
```javascript
const scanner = new BarQRScanner({
  sound: 'industrial' // 'pos' | 'chirp' | 'industrial' | 'bell' | 'double' | 'chord'
});
```
- `'pos'` (default): Clean 880 Hz POS confirmation tone with soft decay.
- `'chirp'`: Snappy upward chirp (1200 &rarr; 1760 Hz) popular in modern iOS apps.
- `'industrial'`: Penetrating 2400 Hz beep for noisy warehouses and fast batch work.
- `'bell'`: Gentle 1046.5 Hz (C6) bell tone with lingering acoustic tail.
- `'double'`: Rapid affirmative two-step chime (880 Hz + 1320 Hz).
- `'chord'`: Polyphonic major triad chord (C5 + E5 + G5).

### 2. Synthesizer Tone Configuration
Fine-tune frequency, duration, volume, and waveform:
```javascript
const scanner = new BarQRScanner({
  sound: {
    frequency: 1760, // in Hz
    duration: 0.08,  // in seconds
    volume: 0.35,    // 0.0 to 1.0
    type: 'sine'     // 'sine' | 'triangle' | 'square' | 'sawtooth'
  }
});
```

### 3. Custom Audio File or Generator Callback
Point to an audio file or write custom Web Audio synthesis:
```javascript
// A. Custom audio file URL
const scanner = new BarQRScanner({
  sound: '/assets/sounds/beep.mp3'
});

// B. Custom generator function (receives shared AudioContext)
const scanner = new BarQRScanner({
  sound: (ctx) => {
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(1500, now);
    osc.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.1);
  }
});
```

---

## Offline / Self-Hosted WASM

For air-gapped environments or intranet applications without internet access:

1. Download `index.js` and `zxing_reader.wasm` from `zxing-wasm@2.1.2`.
2. Host them in your public static assets folder:
   ```
   public/
     vendor/
       zxing/
         index.js
         zxing_reader.wasm
   ```
3. Point the scanner to your local endpoints:
   ```js
   const scanner = new BarQRScanner({
     wasmIifeUrl: '/vendor/zxing/index.js',
     wasmBinaryDir: '/vendor/zxing/'
   });
   ```

---

## License

MIT © [fetzer](mailto:v5oc9e5mk@mozmail.com)
