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
  /** Target <video> element (required for Headless mode, automatically created by .mount()) */
  videoElement?: HTMLVideoElement;
  /** Callback fired on successful barcode or QR detection */
  onScan?: (result: ScanResult) => void;
  /** Error callback for camera or initialization issues */
  onError?: (error: Error) => void;
  /** Status callback for diagnostics and engine switching */
  onStatus?: (message: string) => void;
  /** List of formats to detect */
  formats?: BarcodeFormat[];
  /** Confirmation frame count (default: 2; instant 1 for QR and checksum-verified Code-128) */
  confirmFrames?: number;
  /** Cooldown between scanning identical values in milliseconds (default: 2000) */
  duplicateCooldownMs?: number;
  /** Audio beep on successful scan (default: true) */
  beepOnScan?: boolean;
  /** Haptic vibration on scan when supported (default: true) */
  vibrateOnScan?: boolean;
  /** Region of interest (ROI) ratios, or null for full frame */
  roi?: ROIConfig | null;
  /** Custom URL for the zxing-wasm IIFE bundle (for offline/self-hosted setups) */
  wasmIifeUrl?: string;
  /** Custom directory containing zxing_reader.wasm (for offline/self-hosted setups) */
  wasmBinaryDir?: string;
  /** Force ZXing-C++ WASM engine even if hardware BarcodeDetector is available */
  forceWasm?: boolean;
}

export interface MountOptions extends ScannerOptions {
  /** Viewport height in pixels for the mounted UI widget (default: 280) */
  heightPx?: number;
}

export interface StartInfo {
  engine: 'native' | 'wasm-zxing-1d';
  deviceId: string;
  label: string;
  capabilities: MediaTrackCapabilities;
  settings: MediaTrackSettings;
}

export class BarQRScanner {
  constructor(options?: ScannerOptions);
  start(): Promise<StartInfo>;
  stop(): void;
  destroy(): void;
  switchRearCamera(): Promise<string>;
  refreshCamera(): Promise<void>;
  setTorch(enabled: boolean): Promise<boolean>;
  setSoftwareZoom(factor: number): void;
  get activeEngine(): 'native' | 'wasm-zxing-1d' | null;
  get torchEnabled(): boolean;

  static mount(
    containerOrSelector: HTMLElement | string,
    options?: MountOptions
  ): Promise<BarQRScanner>;
}

export { BarQRScanner as UniversalBarcodeScanner };
export { BarQRScanner as MobileBarcodeScanner };
export default BarQRScanner;
