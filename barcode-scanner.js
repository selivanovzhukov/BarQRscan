/**
 * BarQRscan SDK (v1.0.0)
 * High-performance universal 1D barcode and QR scanner SDK
 * for Android, iOS (iPhone / iPad Safari), Windows, and macOS laptops.
 *
 * Key features:
 *  1) Real browser capability probing (16x16 smoke test) without fragile User-Agent parsing
 *  2) Hardware BarcodeDetector (Android Chrome, macOS) with instant self-healing failover to ZXing-C++ WASM
 *  3) Clean 1D Strip with 24px white quiet zones for dense Code-128 and retail EAN barcodes (15-28 ms)
 *  4) Dual-scale QR detector (Macro 1:1 + Auto-Levels contrast) for fixed-focus laptop webcams
 *  5) Smart camera filtering: eliminates selfie cameras on phones and auto-selects rear macro/torch camera
 *  6) Two integration modes: Headless (pass custom <video>) or one-line UI widget via BarQRScanner.mount()
 */

const DEFAULT_ZXING_IIFE = "https://cdn.jsdelivr.net/npm/zxing-wasm@2.1.2/dist/iife/reader/index.js";
const DEFAULT_ZXING_WASM_DIR = "https://cdn.jsdelivr.net/npm/zxing-wasm@2.1.2/dist/reader/";

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true' || window.ZXingWASM) return resolve();
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => {
      s.dataset.loaded = 'true';
      resolve();
    };
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

function extractClean1DStrip(sourceCanvas, stripCanvas, stripCtx, upscaleFactor = 1.0) {
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  const srcStripH = Math.min(150, Math.max(72, Math.floor(sh * 0.42)));
  const startY = Math.floor((sh - srcStripH) / 2);

  const quietPad = 24;
  const innerW = Math.min(2000, Math.floor(sw * upscaleFactor));
  const dstW = innerW + quietPad * 2;
  const dstH = srcStripH;

  stripCanvas.width = dstW;
  stripCanvas.height = dstH;
  stripCtx.fillStyle = '#ffffff';
  stripCtx.fillRect(0, 0, dstW, dstH);
  stripCtx.imageSmoothingEnabled = true;
  stripCtx.imageSmoothingQuality = 'high';
  stripCtx.drawImage(sourceCanvas, 0, startY, sw, srcStripH, quietPad, 0, innerW, dstH);

  return stripCtx.getImageData(0, 0, dstW, dstH);
}

function normalizeQRContrast(imageData) {
  const data = imageData.data;
  const len = data.length;
  let minLum = 255;
  let maxLum = 0;

  for (let i = 0; i < len; i += 4) {
    const lum = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    if (lum < minLum) minLum = lum;
    if (lum > maxLum) maxLum = lum;
  }

  const range = maxLum - minLum;
  if (range > 30 && range < 200) {
    const scale = 255 / range;
    for (let i = 0; i < len; i += 4) {
      const lum = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      const stretched = Math.min(255, Math.max(0, (lum - minLum) * scale));
      data[i] = stretched;
      data[i + 1] = stretched;
      data[i + 2] = stretched;
    }
  }
}

function extractQRSquare(sourceCanvas, qrCanvas, qrCtx, mode = 'wide', applyContrastBoost = false) {
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  const minDim = Math.min(sw, sh);

  let cropW, cropH, cropX, cropY;
  if (mode === 'macro') {
    const cropDim = Math.floor(minDim * 0.55);
    cropW = cropDim;
    cropH = cropDim;
    cropX = Math.floor((sw - cropDim) / 2);
    cropY = Math.floor((sh - cropDim) / 2);
  } else {
    cropW = minDim;
    cropH = minDim;
    cropX = Math.floor((sw - minDim) / 2);
    cropY = Math.floor((sh - minDim) / 2);
  }

  const targetDim = Math.min(800, cropW);
  qrCanvas.width = targetDim;
  qrCanvas.height = targetDim;
  qrCtx.imageSmoothingEnabled = true;
  qrCtx.imageSmoothingQuality = 'high';
  qrCtx.drawImage(sourceCanvas, cropX, cropY, cropW, cropH, 0, 0, targetDim, targetDim);

  const imgData = qrCtx.getImageData(0, 0, targetDim, targetDim);
  if (applyContrastBoost) {
    normalizeQRContrast(imgData);
  }
  return imgData;
}

export class BarQRScanner {
  constructor(options = {}) {
    this.video = options.videoElement || null;
    this.onScan = options.onScan || (() => {});
    this.onError = options.onError || ((err) => console.error('[BarQRScanner]', err));
    this.onStatus = options.onStatus || ((msg) => console.log('[BarQRScanner]', msg));

    this.formats = options.formats || [
      'qr_code',
      'ean_13',
      'ean_8',
      'code_128',
      'code_39',
      'upc_a',
      'upc_e',
      'itf'
    ];

    this.confirmFrames = typeof options.confirmFrames === 'number' ? options.confirmFrames : 2;
    this.duplicateCooldownMs = typeof options.duplicateCooldownMs === 'number' ? options.duplicateCooldownMs : 2000;
    this.beepOnScan = options.beepOnScan !== false;
    this.vibrateOnScan = options.vibrateOnScan !== false;
    this.roi = options.roi !== undefined ? options.roi : { widthRatio: 0.94, heightRatio: 0.42 };

    this.wasmIifeUrl = options.wasmIifeUrl || DEFAULT_ZXING_IIFE;
    this.wasmBinaryDir = options.wasmBinaryDir || DEFAULT_ZXING_WASM_DIR;
    this.forceWasm = Boolean(options.forceWasm);

    this.isRunning = false;
    this.activeEngine = null;
    this.stream = null;
    this.currentTrack = null;
    this.currentDeviceId = null;
    this.torchEnabled = false;

    this.lastDecodedValue = null;
    this.lastDecodedTime = 0;
    this.pendingCandidate = null;
    this.candidateCount = 0;

    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    this.stripCanvas = document.createElement('canvas');
    this.stripCtx = this.stripCanvas.getContext('2d', { willReadFrequently: true });

    this.qrCanvas = document.createElement('canvas');
    this.qrCtx = this.qrCanvas.getContext('2d', { willReadFrequently: true });

    this.barcodeDetector = null;
    this.zxingWasm = null;
    this.isWasmReading = false;
    this.wasmDecodeCount = 0;

    this.audioCtx = null;
    this.softwareZoomFactor = 1.0;
  }

  beep() {
    if (!this.beepOnScan) return;
    try {
      if (!this.audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) this.audioCtx = new AudioContextClass();
      }
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
      if (!this.audioCtx) return;

      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1760, this.audioCtx.currentTime);
      gain.gain.setValueAtTime(0.15, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + 0.08);
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start();
      osc.stop(this.audioCtx.currentTime + 0.08);
    } catch {
      // Audio autoplay policy fallback
    }
  }

  vibrate() {
    if (!this.vibrateOnScan) return;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(50);
      }
    } catch {
      // Ignore vibration errors
    }
  }

  formatDetectorName(fmt) {
    const map = {
      qr_code: 'qr_code',
      ean_13: 'ean_13',
      ean_8: 'ean_8',
      code_128: 'code_128',
      code_39: 'code_39',
      upc_a: 'upc_a',
      upc_e: 'upc_e',
      itf: 'itf'
    };
    return map[fmt] || fmt;
  }

  mapFormatToWasm(fmt) {
    const map = {
      qr_code: 'QRCode',
      ean_13: 'EAN-13',
      ean_8: 'EAN-8',
      code_128: 'Code128',
      code_39: 'Code39',
      upc_a: 'UPC-A',
      upc_e: 'UPC-E',
      itf: 'ITF'
    };
    return map[fmt] || fmt;
  }

  async initWasm() {
    if (this.zxingWasm) return this.zxingWasm;
    await loadScriptOnce(this.wasmIifeUrl);
    if (!window.ZXingWASM) {
      throw new Error('ZXingWASM module not found after script load');
    }
    if (this.wasmBinaryDir && typeof window.ZXingWASM.setZXingModuleOverrides === 'function') {
      window.ZXingWASM.setZXingModuleOverrides({
        locateFile: (path) => {
          if (path.endsWith('.wasm')) {
            const base = this.wasmBinaryDir.endsWith('/') ? this.wasmBinaryDir : this.wasmBinaryDir + '/';
            return base + path;
          }
          return path;
        }
      });
    }
    this.zxingWasm = window.ZXingWASM;
    return this.zxingWasm;
  }

  async checkNativeSmokeTest(formats) {
    if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return false;
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const activeFormats = formats.filter(f => supported.includes(this.formatDetectorName(f)));
      if (activeFormats.length === 0) return false;

      const detector = new window.BarcodeDetector({
        formats: activeFormats.map(f => this.formatDetectorName(f))
      });

      const smoke = document.createElement('canvas');
      smoke.width = 16;
      smoke.height = 16;
      const sCtx = smoke.getContext('2d');
      const imgData = sCtx.getImageData(0, 0, 16, 16);
      await detector.detect(imgData);

      this.barcodeDetector = detector;
      return true;
    } catch {
      return false;
    }
  }

  async initDetector() {
    if (!this.forceWasm) {
      const nativeOk = await this.checkNativeSmokeTest(this.formats);
      if (nativeOk && this.barcodeDetector) {
        this.activeEngine = 'native';
        this.onStatus(`Active engine: hardware BarcodeDetector`);
        return;
      }
    }

    this.onStatus(`Initializing ZXing-C++ WASM engine...`);
    await this.initWasm();
    this.activeEngine = 'wasm-zxing-1d';
    this.onStatus(`Active engine: ZXing-C++ WASM + Clean 1D Strip`);
  }

  isFrontCamera(label) {
    return /front|user|передні|передня|selfie|facetime/i.test(label);
  }

  async getFilteredCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter(d => d.kind === 'videoinput');

    const rearOnly = videoInputs.filter(c => !this.isFrontCamera(c.label));
    const pool = rearOnly.length > 0 ? rearOnly : videoInputs;

    const seenGroup = new Set();
    const unique = [];
    for (const cam of pool) {
      const key = cam.groupId && cam.groupId !== '' ? cam.groupId : cam.deviceId;
      if (!seenGroup.has(key)) {
        seenGroup.add(key);
        unique.push(cam);
      }
    }
    return unique;
  }

  pickBestCamera(pool) {
    if (!pool || pool.length === 0) return null;
    const cachedTorchId = typeof localStorage !== 'undefined' ? localStorage.getItem('preferred_torch_device_id') : null;
    if (cachedTorchId) {
      const matched = pool.find(c => c.deviceId === cachedTorchId);
      if (matched) return matched;
    }

    return (
      pool.find(c => /потроєна|triple/i.test(c.label)) ||
      pool.find(c => /здвоєна ширококутна|dual wide/i.test(c.label)) ||
      pool.find(c => /здвоєна|dual/i.test(c.label)) ||
      pool.find(c => /camera2?\s*0\b.*back|0,\s*facing back|main|основн/i.test(c.label)) ||
      pool.find(c => /задня|back|rear|environment/i.test(c.label)) ||
      pool[0]
    );
  }

  async startStream(preferredDeviceId = null) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera access requires a secure context (HTTPS or localhost)');
    }

    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }

    const cameras = await this.getFilteredCameras();
    let targetDeviceId = preferredDeviceId;
    if (!targetDeviceId && cameras.length > 0) {
      const best = this.pickBestCamera(cameras);
      if (best) targetDeviceId = best.deviceId;
    }

    const isWasm = this.activeEngine === 'wasm-zxing-1d';
    const idealW = isWasm ? 1920 : 1280;
    const idealH = isWasm ? 1080 : 720;

    const constraints = {
      audio: false,
      video: targetDeviceId
        ? {
            deviceId: { exact: targetDeviceId },
            width: { ideal: idealW },
            height: { ideal: idealH },
            frameRate: { ideal: 30, max: 60 }
          }
        : {
            facingMode: { ideal: 'environment' },
            width: { ideal: idealW },
            height: { ideal: idealH },
            frameRate: { ideal: 30, max: 60 }
          }
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (targetDeviceId) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        });
      } else {
        throw err;
      }
    }

    this.stream = stream;
    this.currentTrack = stream.getVideoTracks()[0];
    this.currentDeviceId = this.currentTrack.getSettings().deviceId || targetDeviceId;

    if (this.video) {
      this.video.srcObject = stream;
      try {
        await this.video.play();
      } catch (playErr) {
        this.onStatus(`Touch screen to start video playback (${playErr.name})`);
      }
    }

    this.probeAndCacheTorchCamera(cameras).catch(() => {});

    return {
      deviceId: this.currentDeviceId,
      label: this.currentTrack.label || 'Default Camera',
      capabilities: this.currentTrack.getCapabilities ? this.currentTrack.getCapabilities() : {},
      settings: this.currentTrack.getSettings ? this.currentTrack.getSettings() : {}
    };
  }

  async probeAndCacheTorchCamera(cameras) {
    if (!this.currentTrack || !this.currentTrack.getCapabilities) return;
    const caps = this.currentTrack.getCapabilities();
    if (caps.torch) {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('preferred_torch_device_id', this.currentDeviceId);
      }
      return;
    }

    if (this.currentDeviceId && typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('preferred_torch_device_id');
      if (stored === this.currentDeviceId) return;
    }

    const otherCameras = cameras.filter(c => c.deviceId !== this.currentDeviceId);
    for (const cam of otherCameras) {
      try {
        const testStream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: cam.deviceId } }
        });
        const track = testStream.getVideoTracks()[0];
        const cCaps = track.getCapabilities ? track.getCapabilities() : {};
        const hasTorch = Boolean(cCaps.torch);
        testStream.getTracks().forEach(t => t.stop());

        if (hasTorch) {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('preferred_torch_device_id', cam.deviceId);
          }
          await this.startStream(cam.deviceId);
          break;
        }
      } catch {
        // Ignore probing errors
      }
    }
  }

  async setTorch(enabled) {
    if (!this.currentTrack || !this.currentTrack.applyConstraints) return false;
    const caps = this.currentTrack.getCapabilities ? this.currentTrack.getCapabilities() : {};
    if (!caps.torch) return false;
    try {
      await this.currentTrack.applyConstraints({
        advanced: [{ torch: Boolean(enabled) }]
      });
      this.torchEnabled = Boolean(enabled);
      return true;
    } catch {
      return false;
    }
  }

  setSoftwareZoom(factor) {
    this.softwareZoomFactor = Math.max(1.0, Math.min(3.0, factor));
  }

  async switchRearCamera() {
    const cameras = await this.getFilteredCameras();
    if (cameras.length <= 1) {
      this.onStatus('Only one camera is available');
      return this.currentDeviceId;
    }
    const idx = cameras.findIndex(c => c.deviceId === this.currentDeviceId);
    const nextIdx = (idx + 1) % cameras.length;
    const nextId = cameras[nextIdx].deviceId;
    await this.startStream(nextId);
    return nextId;
  }

  async refreshCamera() {
    await this.startStream(this.currentDeviceId);
  }

  async start() {
    if (this.isRunning) return;
    await this.initDetector();
    const info = await this.startStream();
    this.isRunning = true;
    this.scanLoop();
    return {
      engine: this.activeEngine,
      ...info
    };
  }

  stop() {
    this.isRunning = false;
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    this.currentTrack = null;
    this.torchEnabled = false;
  }

  destroy() {
    this.stop();
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch {}
      this.audioCtx = null;
    }
    this.barcodeDetector = null;
    this.zxingWasm = null;
  }

  prepareFrameCanvas() {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return null;

    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (this.roi) {
      const rwRatio = Math.max(0.2, Math.min(1.0, this.roi.widthRatio));
      let rhRatio = Math.max(0.15, Math.min(1.0, this.roi.heightRatio));
      if (vw > vh && rhRatio < 0.6) {
        rhRatio = 0.82;
      }
      sw = Math.floor(vw * rwRatio);
      sh = Math.floor(vh * rhRatio);
      sx = Math.floor((vw - sw) / 2);
      sy = Math.floor((vh - sh) / 2);
    }

    if (this.softwareZoomFactor > 1.0) {
      const zsw = Math.floor(sw / this.softwareZoomFactor);
      const zsh = Math.floor(sh / this.softwareZoomFactor);
      sx += Math.floor((sw - zsw) / 2);
      sy += Math.floor((sh - zsh) / 2);
      sw = zsw;
      sh = zsh;
    }

    this.canvas.width = sw;
    this.canvas.height = sh;
    this.ctx.drawImage(this.video, sx, sy, sw, sh, 0, 0, sw, sh);
    return { sw, sh };
  }

  scanLoop() {
    if (!this.isRunning) return;

    if (!this.video || this.video.readyState < 2) {
      requestAnimationFrame(() => this.scanLoop());
      return;
    }

    const t0 = performance.now();
    const frame = this.prepareFrameCanvas();
    if (!frame) {
      requestAnimationFrame(() => this.scanLoop());
      return;
    }

    if (this.activeEngine === 'native' && this.barcodeDetector) {
      const useDirectVideo = (this.wasmDecodeCount % 2 === 1);
      this.wasmDecodeCount++;
      const targetSource = useDirectVideo ? this.video : this.canvas;

      this.barcodeDetector.detect(targetSource)
        .then(barcodes => {
          const elapsed = Math.round(performance.now() - t0);
          if (barcodes && barcodes.length > 0) {
            this.handleDetection({
              value: barcodes[0].rawValue,
              format: barcodes[0].format,
              engine: 'native',
              elapsedMs: elapsed
            });
          }
        })
        .catch(async (detErr) => {
          if (!this.forceWasm && String(detErr.message).includes('service unavailable')) {
            this.onStatus(`Native BarcodeDetector unavailable (${detErr.message}), switching to WASM...`);
            this.activeEngine = 'wasm-zxing-1d';
            await this.initWasm();
          }
        })
        .finally(() => {
          if (this.isRunning) requestAnimationFrame(() => this.scanLoop());
        });
      return;
    }

    if (this.activeEngine === 'wasm-zxing-1d' && this.zxingWasm) {
      if (this.isWasmReading) {
        requestAnimationFrame(() => this.scanLoop());
        return;
      }
      this.isWasmReading = true;
      const pass = this.wasmDecodeCount % 4;
      this.wasmDecodeCount++;

      let imgData;
      let isQrPass = false;

      if (pass === 0) {
        imgData = extractClean1DStrip(this.canvas, this.stripCanvas, this.stripCtx, 1.0);
      } else if (pass === 1) {
        imgData = extractQRSquare(this.canvas, this.qrCanvas, this.qrCtx, 'macro', true);
        isQrPass = true;
      } else if (pass === 2) {
        imgData = extractClean1DStrip(this.canvas, this.stripCanvas, this.stripCtx, 1.35);
      } else {
        imgData = extractQRSquare(this.canvas, this.qrCanvas, this.qrCtx, 'wide', false);
        isQrPass = true;
      }

      const activeFormats = isQrPass
        ? ['QRCode']
        : this.formats.map(f => this.mapFormatToWasm(f)).filter(f => f !== 'QRCode');

      this.zxingWasm.readBarcodes(imgData, {
        formats: activeFormats,
        tryHarder: true,
        tryRotate: false,
        tryInvert: false,
        maxNumberOfSymbols: 1
      })
      .then(symbols => {
        const elapsed = Math.round(performance.now() - t0);
        if (symbols && symbols.length > 0 && symbols[0].isValid) {
          this.handleDetection({
            value: symbols[0].text,
            format: symbols[0].format,
            engine: 'wasm-zxing-1d',
            elapsedMs: elapsed
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        this.isWasmReading = false;
        if (this.isRunning) requestAnimationFrame(() => this.scanLoop());
      });
      return;
    }

    requestAnimationFrame(() => this.scanLoop());
  }

  handleDetection({ value, format, engine, elapsedMs }) {
    if (!value) return;

    const now = performance.now();
    if (this.lastDecodedValue === value && (now - this.lastDecodedTime) < this.duplicateCooldownMs) {
      return;
    }

    const isHighConfidence =
      /qr/i.test(format) ||
      (/code[-_]?128/i.test(format) && value.length >= 8);

    const requiredConfirmations = isHighConfidence ? 1 : this.confirmFrames;

    if (this.pendingCandidate === value) {
      this.candidateCount++;
    } else {
      this.pendingCandidate = value;
      this.candidateCount = 1;
    }

    if (this.candidateCount >= requiredConfirmations) {
      this.lastDecodedValue = value;
      this.lastDecodedTime = now;
      this.pendingCandidate = null;
      this.candidateCount = 0;

      this.beep();
      this.vibrate();

      this.onScan({
        value,
        format,
        engine,
        elapsedMs
      });
    }
  }

  static async mount(containerOrSelector, options = {}) {
    const container = typeof containerOrSelector === 'string'
      ? document.querySelector(containerOrSelector)
      : containerOrSelector;
    if (!container) {
      throw new Error('BarQRScanner.mount: container element not found');
    }

    container.innerHTML = `
      <div class="bqs-root" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#f3f4f6;display:flex;flex-direction:column;gap:8px;width:100%;max-width:480px;">
        <div class="bqs-viewport" style="position:relative;width:100%;height:${options.heightPx || 280}px;background:#000;border-radius:12px;overflow:hidden;border:1px solid #2a2f3a;">
          <video class="bqs-video" playsinline autoplay muted style="width:100%;height:100%;object-fit:cover;display:block;"></video>
          <div class="bqs-viewfinder" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:94%;height:44%;box-shadow:0 0 0 2000px rgba(0,0,0,0.52);border:2px solid #10b981;border-radius:10px;pointer-events:none;transition:border-color 0.2s,background 0.2s;">
            <div style="position:absolute;top:50%;left:3%;right:3%;height:1px;background:rgba(239,68,68,0.8);box-shadow:0 0 6px #ef4444;"></div>
          </div>
        </div>
        <div class="bqs-zoom-row" style="display:flex;align-items:center;gap:8px;background:#181b22;border:1px solid #2a2f3a;border-radius:10px;padding:6px 10px;font-size:12px;">
          <span class="bqs-zoom-label">Zoom: 1.0x</span>
          <input class="bqs-zoom-slider" type="range" min="1" max="3" step="0.1" value="1" style="flex:1;accent-color:#3b82f6;">
        </div>
        <div class="bqs-controls" style="display:flex;gap:6px;flex-wrap:wrap;">
          <button type="button" class="bqs-btn-switch" style="flex:1;padding:8px 10px;border-radius:8px;border:1px solid #3b82f6;background:#3b82f6;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">Switch Camera</button>
          <button type="button" class="bqs-btn-refresh" style="flex:1;padding:8px 10px;border-radius:8px;border:1px solid #2a2f3a;background:#181b22;color:#f3f4f6;font-size:12px;font-weight:600;cursor:pointer;">Reset</button>
          <button type="button" class="bqs-btn-torch" style="display:none;flex:1;padding:8px 10px;border-radius:8px;border:1px solid #2a2f3a;background:#181b22;color:#f3f4f6;font-size:12px;font-weight:600;cursor:pointer;">Torch</button>
        </div>
      </div>
    `;

    const videoEl = container.querySelector('.bqs-video');
    const viewfinderEl = container.querySelector('.bqs-viewfinder');
    const zoomLabelEl = container.querySelector('.bqs-zoom-label');
    const zoomSliderEl = container.querySelector('.bqs-zoom-slider');
    const switchBtn = container.querySelector('.bqs-btn-switch');
    const refreshBtn = container.querySelector('.bqs-btn-refresh');
    const torchBtn = container.querySelector('.bqs-btn-torch');

    const userOnScan = options.onScan || (() => {});
    const scanner = new BarQRScanner({
      ...options,
      videoElement: videoEl,
      onScan: (res) => {
        if (viewfinderEl) {
          viewfinderEl.style.borderColor = '#ffffff';
          viewfinderEl.style.background = 'rgba(16,185,129,0.25)';
          setTimeout(() => {
            viewfinderEl.style.borderColor = '#10b981';
            viewfinderEl.style.background = 'transparent';
          }, 180);
        }
        userOnScan(res);
      }
    });

    const info = await scanner.start();

    if (info && info.capabilities && info.capabilities.torch) {
      torchBtn.style.display = 'block';
      torchBtn.onclick = async () => {
        const nextState = !scanner.torchEnabled;
        const ok = await scanner.setTorch(nextState);
        if (ok) {
          torchBtn.style.background = nextState ? '#eab308' : '#181b22';
          torchBtn.style.borderColor = nextState ? '#eab308' : '#2a2f3a';
          torchBtn.style.color = nextState ? '#000000' : '#f3f4f6';
        }
      };
    }

    switchBtn.onclick = () => scanner.switchRearCamera();
    refreshBtn.onclick = () => scanner.refreshCamera();

    zoomSliderEl.oninput = (e) => {
      const val = parseFloat(e.target.value);
      zoomLabelEl.textContent = `Zoom: ${val.toFixed(1)}x`;
      scanner.setSoftwareZoom(val);
    };

    return scanner;
  }
}

export { BarQRScanner as UniversalBarcodeScanner };
export { BarQRScanner as MobileBarcodeScanner };
export default BarQRScanner;
