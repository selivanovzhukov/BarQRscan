export type BarcodeFormat =
  | 'qr_code'
  | 'ean_13'
  | 'ean_8'
  | 'code_128'
  | 'code_39'
  | 'upc_a'
  | 'upc_e'
  | 'itf';

export interface ScanResult {
  value: string;
  format: string;
  engine: 'native' | 'wasm-zxing-1d' | string;
  elapsedMs: number;
}

export interface ROIConfig {
  widthRatio: number;
  heightRatio: number;
}

export interface ScannerOptions {
  /** Елемент <video> (обов'язковий для Headless-режиму, створюється автоматично у .mount()) */
  videoElement?: HTMLVideoElement;
  /** Колбек при успішному скануванні штрихкоду або QR-коду */
  onScan?: (result: ScanResult) => void;
  /** Колбек помилок камери/ініціалізації */
  onError?: (error: Error) => void;
  /** Інформаційний колбек статусу (обраний рушій, авто-перехід на WASM тощо) */
  onStatus?: (message: string) => void;
  /** Список форматів для декодування */
  formats?: BarcodeFormat[];
  /** Кількість кадрів підтвердження (за замовчуванням 2; для QR та Code-128 з контрольною сумою — миттєво 1) */
  confirmFrames?: number;
  /** Пауза між повторними спрацьовуваннями одного й того ж коду, мс (за замовчуванням 2000) */
  duplicateCooldownMs?: number;
  /** Звуковий сигнал при скануванні (за замовчуванням true) */
  beepOnScan?: boolean;
  /** Вібрація при скануванні (за замовчуванням true) */
  vibrateOnScan?: boolean;
  /** Налаштування зони інтересу (ROI) або null для всього кадру */
  roi?: ROIConfig | null;
  /** Власний URL до IIFE-бандлу zxing-wasm (для офлайн-хостингу) */
  wasmIifeUrl?: string;
  /** Власна папка з файлом zxing_reader.wasm (для офлайн-хостингу) */
  wasmBinaryDir?: string;
  /** Примусово використовувати ZXing-C++ WASM навіть за наявності BarcodeDetector */
  forceWasm?: boolean;
}

export interface MountOptions extends ScannerOptions {
  /** Висота вікна камери у пікселях (за замовчуванням 280) */
  heightPx?: number;
  /** Автоматично запускати камеру після монтування (за замовчуванням true) */
  autoStart?: boolean;
}

export interface StartOptions {
  widthIdeal?: number;
  heightIdeal?: number;
  deviceId?: string;
}

export interface StartResult {
  engine: string;
  capabilities: MediaTrackCapabilities;
  settings: MediaTrackSettings;
}

export declare class UniversalBarcodeScanner {
  constructor(options?: ScannerOptions);
  initDetector(): Promise<void>;
  getAvailableCameras(): Promise<MediaDeviceInfo[]>;
  start(options?: StartOptions): Promise<StartResult | null>;
  stop(): void;
  refreshCamera(): Promise<StartResult | null>;
  switchRearCamera(): Promise<StartResult | null>;
  getCapabilities(): MediaTrackCapabilities;
  setTorch(enabled: boolean): Promise<boolean>;
  setZoom(zoomFactor: number): Promise<{ mode: 'hardware' | 'digital'; zoom: number }>;
  playBeep(freq?: number, durationMs?: number): void;
  destroy?: () => void;

  static mount(
    containerOrSelector: HTMLElement | string,
    options?: MountOptions
  ): Promise<UniversalBarcodeScanner>;
}

export { UniversalBarcodeScanner as MobileBarcodeScanner };
export default UniversalBarcodeScanner;
