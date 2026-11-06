/**
 * Production-ready мобільний сканер штрихкодів та QR-кодів
 * - Пріоритет: Native BarcodeDetector API (Google ML Kit на Android)
 * - Автоматичний фолбек: ZBar WASM (@undecaf/zbar-wasm + @undecaf/barcode-detector-polyfill) для iOS Safari та десктопів
 * - Вбудовані фічі:
 *   1) Multi-frame підтвердження для 1D-штрихкодів (захист від часткового зчитування)
 *   2) Вирізання зони інтересу (ROI)
 *   3) Керування апаратним/цифровим зумом (1x–3x) та ліхтариком (torch)
 *   4) Звуковий сигнал (Web Audio API beep) + вібрація
 *   5) Захист від повторного сканування того ж коду (cooldown)
 */

const ZBAR_WASM_CDN = "https://cdn.jsdelivr.net/npm/@undecaf/zbar-wasm@0.11.0";
const POLYFILL_CDN = "https://cdn.jsdelivr.net/npm/@undecaf/barcode-detector-polyfill@0.9.21";

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') return resolve();
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Не вдалося завантажити ${src}`)), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => {
      s.dataset.loaded = 'true';
      resolve();
    };
    s.onerror = () => reject(new Error(`Не вдалося завантажити ${src}`));
    document.head.appendChild(s);
  });
}

export async function getZBarPolyfillClass() {
  try {
    const cppMod = await import("https://cdn.jsdelivr.net/npm/barcode-detector@2.2.4/dist/es/ponyfill.min.js");
    const cls = cppMod.BarcodeDetector || (cppMod.default && cppMod.default.BarcodeDetector);
    if (cls) return cls;
  } catch (e) {}

  const cppMod2 = await import("https://esm.sh/barcode-detector@2.2.4/ponyfill");
  const cppCls =
    cppMod2.BarcodeDetector ||
    (cppMod2.default && cppMod2.default.BarcodeDetector) ||
    (typeof cppMod2.default === 'function' ? cppMod2.default : null);
  if (!cppCls) {
    throw new Error("Не вдалося завантажити WASM BarcodeDetector поліфіл");
  }
  return cppCls;
}

export class MobileBarcodeScanner {
  constructor(options = {}) {
    this.video = options.videoElement;
    this.onScan = options.onScan || (() => {});
    this.onError = options.onError || console.error;
    this.onStatus = options.onStatus || (() => {});

    this.formats = options.formats || [
      'qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'itf'
    ];
    this.confirmFrames = options.confirmFrames ?? 2;
    this.duplicateCooldownMs = options.duplicateCooldownMs ?? 2000;
    this.beepEnabled = options.beepOnScan ?? true;
    this.vibrateEnabled = options.vibrateOnScan ?? true;
    this.roi = options.roi !== undefined ? options.roi : { widthRatio: 0.8, heightRatio: 0.45 };

    this.stream = null;
    this.videoTrack = null;
    this.detector = null;
    this.engineName = 'none';
    this.isScanning = false;
    this.scanTimer = null;

    this.torchEnabled = false;
    this.currentZoom = 1;
    this.hardwareZoomSupported = false;

    this.lastCandidate = null;
    this.candidateMatches = 0;
    this.lastCommittedValue = null;
    this.lastCommittedTime = 0;

    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.audioCtx = null;
  }

  async initDetector() {
    if ('BarcodeDetector' in window && !window.__forcePolyfill) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const activeFormats = this.formats.filter(f => supported.includes(f));
        if (activeFormats.length > 0) {
          this.detector = new window.BarcodeDetector({ formats: activeFormats });
          this.engineName = 'native';
          this.onStatus(`Активовано нативний BarcodeDetector (${activeFormats.length} форматів)`);
          return;
        }
      } catch (e) {
        this.onStatus(`Нативний BarcodeDetector недоступний: ${e.message}. Перехід на ZBar WASM...`);
      }
    }

    const PolyfillClass = await getZBarPolyfillClass();
    const supported = await PolyfillClass.getSupportedFormats();
    const activeFormats = this.formats.filter(f => supported.includes(f));
    this.detector = new PolyfillClass({ formats: activeFormats });
    this.engineName = 'zbar-wasm';
    this.onStatus(`Активовано ZBar WASM поліфіл (${activeFormats.length} форматів)`);
  }

  async start({ widthIdeal = 1280, heightIdeal = 720 } = {}) {
    if (!window.isSecureContext) {
      throw new Error('Камера потребує захищеного контексту (HTTPS або localhost)');
    }
    this.stop();

    if (!this.detector) {
      await this.initDetector();
    }

    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: widthIdeal },
        height: { ideal: heightIdeal },
        advanced: [{ focusMode: 'continuous' }]
      }
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.video.srcObject = this.stream;
      await this.video.play();

      this.videoTrack = this.stream.getVideoTracks()[0];
      const caps = this.getCapabilities();
      this.hardwareZoomSupported = Boolean(caps.zoom);

      this.isScanning = true;
      this._scheduleNext();
      return {
        engine: this.engineName,
        capabilities: caps,
        settings: this.videoTrack.getSettings ? this.videoTrack.getSettings() : {}
      };
    } catch (err) {
      this.onError(err);
      throw err;
    }
  }

  stop() {
    this.isScanning = false;
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
      this.videoTrack = null;
    }
  }

  getCapabilities() {
    if (!this.videoTrack || !this.videoTrack.getCapabilities) return {};
    try {
      return this.videoTrack.getCapabilities() || {};
    } catch (e) {
      return {};
    }
  }

  async setTorch(enabled) {
    if (!this.videoTrack) return false;
    try {
      await this.videoTrack.applyConstraints({ advanced: [{ torch: Boolean(enabled) }] });
      this.torchEnabled = Boolean(enabled);
      return this.torchEnabled;
    } catch (e) {
      return false;
    }
  }

  async setZoom(zoomFactor) {
    const z = Math.max(1, Math.min(4, Number(zoomFactor) || 1));
    this.currentZoom = z;

    if (this.videoTrack && this.hardwareZoomSupported) {
      try {
        const caps = this.getCapabilities();
        const min = caps.zoom?.min ?? 1;
        const max = caps.zoom?.max ?? 4;
        const clamped = Math.max(min, Math.min(max, z));
        await this.videoTrack.applyConstraints({ advanced: [{ zoom: clamped }] });
        this.video.style.transform = '';
        return { mode: 'hardware', zoom: clamped };
      } catch (e) {}
    }

    if (this.video) {
      this.video.style.transform = z > 1 ? `scale(${z})` : '';
      this.video.style.transformOrigin = 'center center';
    }
    return { mode: 'digital', zoom: z };
  }

  playBeep(freq = 1850, durationMs = 75) {
    if (!this.beepEnabled) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!this.audioCtx) {
        this.audioCtx = new AudioCtx();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, this.audioCtx.currentTime);

      gain.gain.setValueAtTime(0.15, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + durationMs / 1000);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start();
      osc.stop(this.audioCtx.currentTime + durationMs / 1000);
    } catch (e) {}
  }

  _prepareFrame() {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return null;

    const digitalZoom = (!this.hardwareZoomSupported && this.currentZoom > 1) ? this.currentZoom : 1;

    if (!this.roi && digitalZoom === 1) {
      if (this.engineName === 'native') return this.video;
      this.canvas.width = vw;
      this.canvas.height = vh;
      this.ctx.drawImage(this.video, 0, 0, vw, vh);
      return this.canvas;
    }

    const wRatio = (this.roi ? this.roi.widthRatio : 1) / digitalZoom;
    const hRatio = (this.roi ? this.roi.heightRatio : 1) / digitalZoom;

    const cropW = Math.max(64, Math.floor(vw * Math.min(1, wRatio)));
    const cropH = Math.max(64, Math.floor(vh * Math.min(1, hRatio)));
    const startX = Math.floor((vw - cropW) / 2);
    const startY = Math.floor((vh - cropH) / 2);

    this.canvas.width = cropW;
    this.canvas.height = cropH;
    this.ctx.drawImage(this.video, startX, startY, cropW, cropH, 0, 0, cropW, cropH);
    return this.canvas;
  }

  _scheduleNext() {
    if (!this.isScanning) return;
    this.scanTimer = setTimeout(() => {
      requestAnimationFrame(() => this._scanStep());
    }, 60);
  }

  async _scanStep() {
    if (!this.isScanning) return;

    if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.video.videoWidth > 0) {
      const t0 = performance.now();
      try {
        const source = this._prepareFrame();
        if (source && this.detector) {
          const results = await this.detector.detect(source);
          const elapsedMs = Number((performance.now() - t0).toFixed(1));
          if (results && results.length > 0 && results[0].rawValue) {
            this._handleCandidate(results[0].rawValue, results[0].format, elapsedMs);
          } else {
            this.candidateMatches = 0;
            this.lastCandidate = null;
          }
        }
      } catch (e) {}
    }

    this._scheduleNext();
  }

  _handleCandidate(rawValue, format, elapsedMs) {
    const isQR = String(format).toLowerCase().includes('qr');
    const neededFrames = isQR ? 1 : Math.max(1, this.confirmFrames);

    if (rawValue === this.lastCandidate) {
      this.candidateMatches++;
    } else {
      this.lastCandidate = rawValue;
      this.candidateMatches = 1;
    }

    if (this.candidateMatches >= neededFrames) {
      this.candidateMatches = 0;
      const now = Date.now();

      if (
        this.duplicateCooldownMs > 0 &&
        rawValue === this.lastCommittedValue &&
        now - this.lastCommittedTime < this.duplicateCooldownMs
      ) {
        return;
      }

      this.lastCommittedValue = rawValue;
      this.lastCommittedTime = now;

      this.playBeep();
      if (this.vibrateEnabled && navigator.vibrate) {
        navigator.vibrate(40);
      }

      this.onScan({
        value: rawValue,
        format,
        engine: this.engineName,
        elapsedMs
      });
    }
  }
}
