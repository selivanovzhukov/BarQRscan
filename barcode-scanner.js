/**
 * UniversalBarcodeScanner SDK (v1.0.0)
 * Універсальна бібліотека сканування штрихкодів (Code-128, EAN-13, EAN-8, UPC, Code-39, ITF) та QR-кодів
 * для Android, iOS (iPhone / iPad Safari), Windows та macOS лептопів.
 *
 * Ключові можливості:
 *  1) Перевірка реальних можливостей браузера (Smoke Test 16x16) без прив'язки до User-Agent
 *  2) Апаратний Google ML Kit / ShapeDetection (Android Chrome, macOS) + миттєвий Self-Healing фолбек на ZXing-C++ WASM
 *  3) Clean 1D Strip із білими полями (Quiet Zone 24px) для надрукованих і довгих Code-128 (15-28 мс на iPhone та ПК)
 *  4) Двомасштабний QR-детектор (Macro 1:1 + Auto-Levels контраст) для веб-камер ноутбуків із фіксованим фокусом
 *  5) Повне відсікання фронтальних камер на смартфонах + авто-пошук задньої камери з ліхтариком (🔦) та макро
 *  6) Два режими інтеграції: Headless (передача <video>) або готовий UI-віджет у 1 рядок через UniversalBarcodeScanner.mount()
 */

const DEFAULT_ZXING_IIFE = "https://cdn.jsdelivr.net/npm/zxing-wasm@2.1.2/dist/iife/reader/index.js";
const DEFAULT_ZXING_WASM_DIR = "https://cdn.jsdelivr.net/npm/zxing-wasm@2.1.2/dist/reader/";

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true' || window.ZXingWASM) return resolve();
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

export async function createIOSHybridDetector(ctx, { wasmIifeUrl = DEFAULT_ZXING_IIFE, wasmBinaryDir = DEFAULT_ZXING_WASM_DIR } = {}) {
  const stripCanvas = document.createElement('canvas');
  const stripCtx = stripCanvas.getContext('2d', { willReadFrequently: true });
  let zxingReadBarcodes = null;
  let frameIndex = 0;

  try {
    if (!window.ZXingWASM) {
      await loadScriptOnce(wasmIifeUrl);
    }
    const zxGlobal = window.ZXingWASM;
    if (zxGlobal) {
      if (zxGlobal.prepareZXingModule) {
        const baseDir = wasmBinaryDir.endsWith('/') ? wasmBinaryDir : `${wasmBinaryDir}/`;
        zxGlobal.prepareZXingModule({
          overrides: {
            locateFile: (path, prefix) => {
              if (path.endsWith(".wasm")) {
                return `${baseDir}${path}`;
              }
              return prefix + path;
            }
          }
        });
      }
      const candidateFn = zxGlobal.readBarcodes || zxGlobal.readBarcodesFromImageData;
      if (candidateFn) {
        await candidateFn(new ImageData(16, 16), {
          tryHarder: true,
          formats: ["Code128", "QRCode"]
        });
        zxingReadBarcodes = candidateFn;
      }
    }
  } catch (e) {
    zxingReadBarcodes = null;
  }

  const qrCanvas = document.createElement('canvas');
  const qrCtx = qrCanvas.getContext('2d', { willReadFrequently: true });

  function normalizeQRContrast(imgData) {
    const d = imgData.data;
    const len = d.length;
    let minL = 255;
    let maxL = 0;

    for (let i = 0; i < len; i += 16) {
      const lum = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      if (lum < minL) minL = lum;
      if (lum > maxL) maxL = lum;
    }

    const range = maxL - minL;
    if (range < 25) return imgData;

    const blackCut = minL + Math.floor(range * 0.18);
    const whiteCut = maxL - Math.floor(range * 0.18);
    const effRange = Math.max(1, whiteCut - blackCut);
    const scale = (255 * 256) / effRange;

    for (let i = 0; i < len; i += 4) {
      const lum = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      let v = ((lum - blackCut) * scale) >> 8;
      if (v < 0) v = 0;
      else if (v > 255) v = 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    return imgData;
  }

  function extractQRSquare(sourceCanvas, mode = 'wide', applyContrast = false) {
    const sw = sourceCanvas.width;
    const sh = sourceCanvas.height;
    const maxSide = Math.min(sw, sh);

    const cropSide = (mode === 'macro')
      ? Math.min(maxSide, Math.max(260, Math.floor(maxSide * 0.48)))
      : maxSide;
    const startX = Math.floor((sw - cropSide) / 2);
    const startY = Math.floor((sh - cropSide) / 2);

    const dstSide = (mode === 'macro')
      ? Math.min(640, Math.floor(cropSide * 1.35))
      : Math.min(680, cropSide);

    qrCanvas.width = dstSide;
    qrCanvas.height = dstSide;
    qrCtx.imageSmoothingEnabled = true;
    qrCtx.imageSmoothingQuality = 'high';
    qrCtx.drawImage(sourceCanvas, startX, startY, cropSide, cropSide, 0, 0, dstSide, dstSide);

    const imgData = qrCtx.getImageData(0, 0, dstSide, dstSide);
    return applyContrast ? normalizeQRContrast(imgData) : imgData;
  }

  const zxingFormatsAll = ["QRCode", "Code128", "Code39", "EAN-13", "EAN-8", "UPC-A", "UPC-E", "ITF"];
  const zxingFormats1D = ["Code128", "Code39", "EAN-13", "EAN-8", "UPC-A", "ITF"];

  return {
    async detect(canvas) {
      if (!zxingReadBarcodes) return [];
      frameIndex++;
      const upscale = (frameIndex % 2 === 0) ? 1.0 : 1.35;
      const stripImgData = extractClean1DStrip(canvas, stripCanvas, stripCtx, upscale);

      try {
        const resStrip = await zxingReadBarcodes(stripImgData, {
          tryHarder: true,
          tryRotate: false,
          tryInvert: true,
          tryDownscale: true,
          binarizer: (frameIndex % 3 === 0) ? "GlobalHistogram" : "LocalAverage",
          formats: zxingFormats1D,
          maxNumberOfSymbols: 1
        });
        if (resStrip && resStrip.length > 0 && resStrip[0].text) {
          return [{
            rawValue: resStrip[0].text,
            format: String(resStrip[0].format || 'code_128').toLowerCase()
          }];
        }
      } catch (e) { }

      try {
        const isLandscapeCam = canvas.width > canvas.height;
        const primaryMode = (frameIndex % 2 === 0) ? 'macro' : 'wide';
        const useContrast = (frameIndex % 2 === 0) || isLandscapeCam;

        const qrImgData = extractQRSquare(canvas, primaryMode, useContrast);
        const resQR = await zxingReadBarcodes(qrImgData, {
          tryHarder: true,
          tryRotate: true,
          tryInvert: true,
          tryDownscale: true,
          binarizer: (frameIndex % 3 === 0) ? "GlobalHistogram" : "LocalAverage",
          formats: ["QRCode"],
          maxNumberOfSymbols: 1
        });
        if (resQR && resQR.length > 0 && resQR[0].text) {
          return [{
            rawValue: resQR[0].text,
            format: 'qr_code'
          }];
        }

        if (isLandscapeCam) {
          const secondaryMode = primaryMode === 'macro' ? 'wide' : 'macro';
          const qrImgData2 = extractQRSquare(canvas, secondaryMode, !useContrast);
          const resQR2 = await zxingReadBarcodes(qrImgData2, {
            tryHarder: true,
            tryRotate: true,
            tryInvert: true,
            tryDownscale: true,
            binarizer: "LocalAverage",
            formats: ["QRCode"],
            maxNumberOfSymbols: 1
          });
          if (resQR2 && resQR2.length > 0 && resQR2[0].text) {
            return [{
              rawValue: resQR2[0].text,
              format: 'qr_code'
            }];
          }
        }
      } catch (e) { }

      if (frameIndex % 2 === 0) {
        try {
          const fullImgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const resFull = await zxingReadBarcodes(fullImgData, {
            tryHarder: true,
            tryRotate: (frameIndex % 6 === 0),
            tryInvert: true,
            tryDownscale: true,
            binarizer: "LocalAverage",
            formats: zxingFormatsAll,
            maxNumberOfSymbols: 1
          });
          if (resFull && resFull.length > 0 && resFull[0].text) {
            return [{
              rawValue: resFull[0].text,
              format: String(resFull[0].format || 'qrcode').toLowerCase()
            }];
          }
        } catch (e) { }
      }

      return [];
    }
  };
}

export const createDirectZBarDetector = createIOSHybridDetector;

export class MobileBarcodeScanner {
  constructor(options = {}) {
    this.video = options.videoElement;
    this.onScan = options.onScan || (() => { });
    this.onError = options.onError || console.error;
    this.onStatus = options.onStatus || (() => { });

    this.formats = options.formats || [
      'qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'itf'
    ];
    this.confirmFrames = options.confirmFrames ?? 2;
    this.duplicateCooldownMs = options.duplicateCooldownMs ?? 2000;
    this.beepEnabled = options.beepOnScan ?? true;
    this.vibrateEnabled = options.vibrateOnScan ?? true;
    this.roi = options.roi !== undefined ? options.roi : { widthRatio: 0.96, heightRatio: 0.44 };
    this.wasmIifeUrl = options.wasmIifeUrl || DEFAULT_ZXING_IIFE;
    this.wasmBinaryDir = options.wasmBinaryDir || DEFAULT_ZXING_WASM_DIR;
    this.forceWasm = Boolean(options.forceWasm);

    this.stream = null;
    this.videoTrack = null;
    this.detector = null;
    this.wasmDetector = null;
    this.nativeBroken = false;
    this.engineName = 'none';
    this.isScanning = false;
    this.scanSessionId = 0;
    this.isStepRunning = false;
    this.scanTimer = null;
    this.frameCounter = 0;

    this.torchEnabled = false;
    this.currentZoom = 1;
    this.hardwareZoomSupported = false;
    this.torchSupportByDevice = new Map();
    this.probedNoTorchDevices = new Set();

    this.lastCandidate = null;
    this.candidateMatches = 0;
    this.lastCandidateTime = 0;
    this.lastCommittedValue = null;
    this.lastCommittedTime = 0;

    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.audioCtx = null;
  }

  async initDetector() {
    if ('BarcodeDetector' in window && !window.__forcePolyfill && !this.forceWasm && !this.nativeBroken) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const activeFormats = this.formats.filter(f => supported.includes(f));
        if (activeFormats.includes('code_128') && activeFormats.includes('qr_code')) {
          const candidate = new window.BarcodeDetector({ formats: activeFormats });
          await candidate.detect(new ImageData(16, 16));
          this.detector = candidate;
          this.engineName = 'native';
          this.onStatus(`Активовано апаратний BarcodeDetector (${activeFormats.length} форматів)`);
        }
      } catch (e) {
        this.nativeBroken = true;
        this.detector = null;
        this.onStatus(`Сервіс BarcodeDetector недоступний (${e.message}). Перехід на ZXing-C++ WASM...`);
      }
    }

    if (!this.wasmDetector) {
      this.wasmDetector = await createIOSHybridDetector(this.ctx, {
        wasmIifeUrl: this.wasmIifeUrl,
        wasmBinaryDir: this.wasmBinaryDir
      });
    }

    if (!this.detector) {
      this.detector = this.wasmDetector;
      this.engineName = 'wasm-zxing-1d';
      this.onStatus(`Активовано універсальний ZXing-C++ WASM + Clean 1D Strip`);
    }
  }

  _isFrontCameraLabel(label = '') {
    return /front|user|передні|передня|selfie|facetime/i.test(label);
  }

  async getAvailableCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      const rearDevices = videoDevices.filter(d => !this._isFrontCameraLabel(d.label));
      // Якщо є хоча б одна задня камера (мобільний/планшет) — приховуємо всі фронтальні камери;
      // якщо задніх немає (лептоп Windows / macOS) — повертаємо доступні веб-камери
      return rearDevices.length > 0 ? rearDevices : videoDevices;
    } catch (e) {
      return [];
    }
  }

  async _pickBestCamera() {
    const cameras = await this.getAvailableCameras();
    if (!cameras.length) return null;

    for (const [devId, hasTorch] of this.torchSupportByDevice.entries()) {
      if (hasTorch && cameras.some(c => c.deviceId === devId)) {
        return devId;
      }
    }
    try {
      const savedTorchId = localStorage.getItem('preferred_torch_device_id');
      if (savedTorchId && cameras.some(c => c.deviceId === savedTorchId) && !this.probedNoTorchDevices.has(savedTorchId)) {
        return savedTorchId;
      }
    } catch (e) { }

    const candidates = cameras.filter(c => !this.probedNoTorchDevices.has(c.deviceId));
    const pool = candidates.length > 0 ? candidates : cameras;

    const preferred =
      pool.find(c => /потроєна|triple/i.test(c.label)) ||
      pool.find(c => /здвоєна ширококутна|dual wide/i.test(c.label)) ||
      pool.find(c => /здвоєна|dual/i.test(c.label)) ||
      pool.find(c => /camera2?\s*0\b.*back|0,\s*facing back|main|основн/i.test(c.label)) ||
      pool.find(c => /задня|back|rear|environment/i.test(c.label)) ||
      pool[0];

    return preferred ? preferred.deviceId : null;
  }

  async start({ widthIdeal, heightIdeal, deviceId } = {}) {
    if (!window.isSecureContext) {
      throw new Error('Камера потребує захищеного контексту (HTTPS або localhost)');
    }
    const hadStream = Boolean(this.stream);
    this.stop();
    const mySessionId = ++this.scanSessionId;

    if (hadStream) {
      await new Promise(r => setTimeout(r, 180));
      if (mySessionId !== this.scanSessionId) return null;
    }

    if (!this.detector) {
      await this.initDetector();
    }

    // Авто-вибір роздільної здатності за активним рушієм (720p для ML Kit, 1080p для WASM)
    const hIdeal = heightIdeal || (this.engineName === 'native' ? 720 : 1080);
    const wIdeal = widthIdeal || (hIdeal === 1080 ? 1920 : 1280);
    const bestDeviceId = deviceId || (await this._pickBestCamera());

    const buildConstraints = (targetDeviceId) => {
      const c = {
        width: { ideal: wIdeal },
        height: { ideal: hIdeal },
        advanced: [{ focusMode: 'continuous' }]
      };
      if (targetDeviceId) {
        c.deviceId = { exact: targetDeviceId };
      } else {
        c.facingMode = { ideal: 'environment' };
      }
      return c;
    };

    try {
      let newStream;
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: buildConstraints(bestDeviceId)
        });
      } catch (firstErr) {
        newStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { width: { ideal: wIdeal }, height: { ideal: hIdeal }, facingMode: { ideal: 'environment' } }
        });
      }

      if (mySessionId !== this.scanSessionId) {
        newStream.getTracks().forEach(t => t.stop());
        return null;
      }
      this.stream = newStream;
      this.video.srcObject = this.stream;
      this.video.muted = true;
      this.video.defaultMuted = true;
      this.video.playsInline = true;

      try {
        await this.video.play();
      } catch (playErr) {
        this.onStatus(`Торкніться екрана для старту відео (${playErr.name})`);
        const resume = () => this.video.play().catch(() => { });
        document.addEventListener('touchstart', resume, { once: true });
        document.addEventListener('click', resume, { once: true });
      }

      this.videoTrack = this.stream.getVideoTracks()[0];
      const settings = this.videoTrack.getSettings ? this.videoTrack.getSettings() : {};
      const caps = this.getCapabilities();
      this.hardwareZoomSupported = Boolean(caps.zoom);
      const hasTorch = Boolean(caps.torch);

      if (settings.deviceId) {
        this.torchSupportByDevice.set(settings.deviceId, hasTorch);
        if (hasTorch) {
          try { localStorage.setItem('preferred_torch_device_id', settings.deviceId); } catch (e) { }
        } else {
          this.probedNoTorchDevices.add(settings.deviceId);
        }
      }

      // Авто-пошук задньої камери з ліхтариком, якщо поточна без ліхтарика і користувач не задавав deviceId вручну
      if (!deviceId) {
        const allFiltered = await this.getAvailableCameras();
        const betterId = await this._pickBestCamera();
        const hasUnprobedAlt = allFiltered.some(c => c.deviceId !== settings.deviceId && !this.probedNoTorchDevices.has(c.deviceId));
        if (betterId && settings.deviceId && betterId !== settings.deviceId && (!hasTorch || !this._autoSwitchedLens) && hasUnprobedAlt) {
          this._autoSwitchedLens = true;
          return this.start({ widthIdeal, heightIdeal, deviceId: betterId });
        }
      }

      this.isScanning = true;
      this._scheduleNext(mySessionId);
      return {
        engine: this.engineName,
        capabilities: caps,
        settings
      };
    } catch (err) {
      this.onError(err);
      throw err;
    }
  }

  async refreshCamera() {
    const curId = this.videoTrack && this.videoTrack.getSettings ? this.videoTrack.getSettings().deviceId : undefined;
    return this.start({ deviceId: curId });
  }

  async switchRearCamera() {
    const cameras = await this.getAvailableCameras();
    if (cameras.length <= 1) {
      return this.refreshCamera();
    }
    const curId = this.videoTrack && this.videoTrack.getSettings ? this.videoTrack.getSettings().deviceId : '';
    const idx = cameras.findIndex(c => c.deviceId === curId);
    const nextCam = cameras[(idx + 1) % cameras.length];
    return this.start({ deviceId: nextCam.deviceId });
  }

  stop() {
    this.isScanning = false;
    this.scanSessionId++;
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
      this.videoTrack = null;
    }
    if (this.video) {
      this.video.srcObject = null;
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
      } catch (e) { }
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
    } catch (e) { }
  }

  _prepareFrame(forceCanvasCrop = false) {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return null;

    this.frameCounter++;
    const digitalZoom = (!this.hardwareZoomSupported && this.currentZoom > 1) ? this.currentZoom : 1;

    // В апаратному режимі чергуємо швидкий ROI-кроп (парні кадри) та прямий відеопотік (непарні кадри)
    if (
      !forceCanvasCrop &&
      this.engineName === 'native' &&
      this.frameCounter % 2 === 1 &&
      (this.hardwareZoomSupported || digitalZoom === 1)
    ) {
      return this.video;
    }

    if (!this.roi && digitalZoom === 1) {
      this.canvas.width = vw;
      this.canvas.height = vh;
      this.ctx.drawImage(this.video, 0, 0, vw, vh);
      return this.canvas;
    }

    const isPortraitStream = vh > vw;
    const baseH = this.roi ? (isPortraitStream ? Math.min(this.roi.heightRatio, 0.26) : Math.max(this.roi.heightRatio, 0.82)) : 1;
    const wRatio = (this.roi ? this.roi.widthRatio : 1) / digitalZoom;
    const hRatio = baseH / digitalZoom;

    const cropW = Math.max(64, Math.floor(vw * Math.min(1, wRatio)));
    const cropH = Math.max(64, Math.floor(vh * Math.min(1, hRatio)));
    const startX = Math.floor((vw - cropW) / 2);
    const startY = Math.floor((vh - cropH) / 2);

    this.canvas.width = cropW;
    this.canvas.height = cropH;
    this.ctx.drawImage(this.video, startX, startY, cropW, cropH, 0, 0, cropW, cropH);
    return this.canvas;
  }

  _scheduleNext(sessionId = this.scanSessionId) {
    if (!this.isScanning || sessionId !== this.scanSessionId) return;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      requestAnimationFrame(() => this._scanStep(sessionId));
    }, 45);
  }

  async _scanStep(sessionId) {
    if (!this.isScanning || sessionId !== this.scanSessionId || this.isStepRunning) return;
    this.isStepRunning = true;

    try {
      if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.video.videoWidth > 0) {
        const t0 = performance.now();
        try {
          const source = this._prepareFrame();
          if (source && this.detector) {
            let results = [];
            try {
              results = await this.detector.detect(source);
            } catch (detErr) {
              // Самовідновлення в рантаймі: якщо сервіс BarcodeDetector недоступний — перемикаємося на WASM
              if (this.engineName === 'native' && this.wasmDetector) {
                this.nativeBroken = true;
                this.detector = this.wasmDetector;
                this.engineName = 'wasm-zxing-1d';
                this.onStatus(`Сервіс BarcodeDetector відмовив (${detErr.message}) — авто-перехід на WASM!`);
                const fallbackCanvas = this._prepareFrame(true);
                if (fallbackCanvas) {
                  results = await this.detector.detect(fallbackCanvas);
                }
              }
            }
            const elapsedMs = Number((performance.now() - t0).toFixed(1));
            if (results && results.length > 0 && results[0].rawValue) {
              this._handleCandidate(results[0].rawValue, results[0].format, elapsedMs);
            } else if (this.lastCandidate && (Date.now() - this.lastCandidateTime) > 1400) {
              this.candidateMatches = 0;
              this.lastCandidate = null;
            }
          }
        } catch (e) { }
      }
    } finally {
      this.isStepRunning = false;
      if (this.isScanning && sessionId === this.scanSessionId) {
        this._scheduleNext(sessionId);
      }
    }
  }

  _handleCandidate(rawValue, format, elapsedMs) {
    const fmtLower = String(format).toLowerCase();
    const isQR = fmtLower.includes('qr');
    const isCode128WithChecksum = fmtLower.includes('128') && rawValue.length >= 4;
    const neededFrames = (isQR || (isCode128WithChecksum && this.confirmFrames <= 2))
      ? 1
      : Math.max(1, this.confirmFrames);

    const now = Date.now();
    if (rawValue === this.lastCandidate && (now - this.lastCandidateTime) <= 1400) {
      this.candidateMatches++;
      this.lastCandidateTime = now;
    } else {
      this.lastCandidate = rawValue;
      this.candidateMatches = 1;
      this.lastCandidateTime = now;
    }

    if (this.candidateMatches >= neededFrames) {
      this.candidateMatches = 0;
      this.lastCandidate = null;

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

  /**
   * Готовий UI-віджет у 1 рядок коду: створює відеопотік, рамку прицілу, повзунок зуму (1x-3x)
   * та кнопки (🔄 Камера, ♻️ Перезапуск, 🔦 Ліхтарик) всередині переданого контейнера.
   */
  static async mount(containerOrSelector, options = {}) {
    const container = typeof containerOrSelector === 'string'
      ? document.querySelector(containerOrSelector)
      : containerOrSelector;
    if (!container) {
      throw new Error('UniversalBarcodeScanner.mount: контейнер не знайдено');
    }

    container.innerHTML = `
      <div class="ubs-root" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#f3f4f6;display:flex;flex-direction:column;gap:8px;width:100%;max-width:480px;">
        <div class="ubs-viewport" style="position:relative;width:100%;height:${options.heightPx || 280}px;background:#000;border-radius:12px;overflow:hidden;border:1px solid #2a2f3a;">
          <video class="ubs-video" playsinline autoplay muted style="width:100%;height:100%;object-fit:cover;display:block;"></video>
          <div class="ubs-viewfinder" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:94%;height:44%;box-shadow:0 0 0 2000px rgba(0,0,0,0.52);border:2px solid #10b981;border-radius:10px;pointer-events:none;transition:border-color 0.2s,background 0.2s;">
            <div style="position:absolute;top:50%;left:3%;right:3%;height:1px;background:rgba(239,68,68,0.8);box-shadow:0 0 6px #ef4444;"></div>
          </div>
        </div>
        <div class="ubs-zoom-row" style="display:flex;align-items:center;gap:8px;background:#181b22;border:1px solid #2a2f3a;border-radius:10px;padding:6px 10px;font-size:12px;">
          <span class="ubs-zoom-label">🔍 1.0×</span>
          <input class="ubs-zoom-slider" type="range" min="1" max="3" step="0.1" value="1" style="flex:1;accent-color:#3b82f6;">
        </div>
        <div class="ubs-controls" style="display:flex;gap:6px;flex-wrap:wrap;">
          <button type="button" class="ubs-btn-switch" style="flex:1;padding:8px 10px;border-radius:8px;border:1px solid #3b82f6;background:#3b82f6;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">🔄 Камера</button>
          <button type="button" class="ubs-btn-refresh" style="flex:1;padding:8px 10px;border-radius:8px;border:1px solid #2a2f3a;background:#181b22;color:#f3f4f6;font-size:12px;font-weight:600;cursor:pointer;">♻️ Перезапуск</button>
          <button type="button" class="ubs-btn-torch" style="display:none;flex:1;padding:8px 10px;border-radius:8px;border:1px solid #2a2f3a;background:#181b22;color:#f3f4f6;font-size:12px;font-weight:600;cursor:pointer;">🔦 Ліхтарик</button>
        </div>
      </div>
    `;

    const videoEl = container.querySelector('.ubs-video');
    const viewfinderEl = container.querySelector('.ubs-viewfinder');
    const zoomLabelEl = container.querySelector('.ubs-zoom-label');
    const zoomSliderEl = container.querySelector('.ubs-zoom-slider');
    const switchBtn = container.querySelector('.ubs-btn-switch');
    const refreshBtn = container.querySelector('.ubs-btn-refresh');
    const torchBtn = container.querySelector('.ubs-btn-torch');

    const userOnScan = options.onScan || (() => { });
    const scanner = new MobileBarcodeScanner({
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

    const updateTorchVisibility = () => {
      const caps = scanner.getCapabilities();
      torchBtn.style.display = caps && caps.torch ? 'inline-block' : 'none';
    };

    zoomSliderEl.addEventListener('input', (e) => {
      const z = parseFloat(e.target.value) || 1;
      zoomLabelEl.textContent = `🔍 ${z.toFixed(1)}×`;
      scanner.setZoom(z);
    });

    switchBtn.addEventListener('click', async () => {
      await scanner.switchRearCamera();
      updateTorchVisibility();
    });

    refreshBtn.addEventListener('click', async () => {
      await scanner.refreshCamera();
      updateTorchVisibility();
    });

    torchBtn.addEventListener('click', async () => {
      const active = await scanner.setTorch(!scanner.torchEnabled);
      torchBtn.textContent = active ? '🔦 Вимкнути' : '🔦 Ліхтарик';
      torchBtn.style.background = active ? '#f59e0b' : '#181b22';
      torchBtn.style.color = active ? '#000' : '#f3f4f6';
    });

    if (options.autoStart !== false) {
      await scanner.start();
      updateTorchVisibility();
    }

    scanner.destroy = () => {
      scanner.stop();
      container.innerHTML = '';
    };

    return scanner;
  }
}

export const UniversalBarcodeScanner = MobileBarcodeScanner;
export default MobileBarcodeScanner;

if (typeof window !== 'undefined') {
  window.UniversalBarcodeScanner = MobileBarcodeScanner;
  window.MobileBarcodeScanner = MobileBarcodeScanner;
}
