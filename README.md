# Universal Barcode & QR Scanner SDK (`v1.0.0`)

Універсальна бібліотека для швидкого та надійного сканування **1D-штрихкодів (`Code-128`, `EAN-13`, `EAN-8`, `UPC-A`, `Code-39`, `ITF`)** та **2D `QR-кодів`** на всіх платформах:
- **Android (Chrome, Samsung Internet, Firefox):** апаратний прискорювач Google ML Kit (`BarcodeDetector`) із автоматичним самовідновленням (`Self-Healing`) на WASM, якщо системний сервіс недоступний.
- **iOS (iPhone / iPad Safari та WebKit):** високошвидкісний C++20 `ZXing-WASM` + чиста 1D-смужка з білими полями (`Quiet Zone 24px`) і авто-вибором мульти-камери з макрофокусом (`19–28 мс` на кадр).
- **Windows та macOS лептопи:** підтримка вбудованих і USB веб-камер з фіксованим фокусом завдяки двомасштабному QR-детектору (`Macro 1:1` + `Auto-Levels` контраст).
- **Розумне керування камерами:** повне відсікання фронтальних (селфі) камер на смартфонах/планшетах та автоматичний пошук заднього об'єктива з фізичним ліхтариком (`🔦`).

---

## 1. Підключення

Скопіюйте файли [`barcode-scanner.js`](./barcode-scanner.js) та [`barcode-scanner.d.ts`](./barcode-scanner.d.ts) у свій проєкт або встановіть пакет локально:

```bash
npm install ./шлях-до-папки-sdk
```

---

## 2. Варіант А — Готовий UI-віджет у 1 рядок (`.mount()`)

Найшвидший спосіб додати сканер із готовою рамкою прицілу, повзунком зуму (`1×–3×`) та кнопками (`🔄 Камера`, `♻️ Перезапуск`, `🔦 Ліхтарик`):

```html
<div id="scanner-box"></div>

<script type="module">
  import { UniversalBarcodeScanner } from './barcode-scanner.js';

  const scanner = await UniversalBarcodeScanner.mount('#scanner-box', {
    duplicateCooldownMs: 1500,
    onScan: ({ value, format, engine, elapsedMs }) => {
      console.log(`Зчитано: ${value} (${format}) за ${elapsedMs} мс [${engine}]`);
    }
  });

  // Коли сканер більше не потрібен:
  // scanner.destroy();
</script>
```

---

## 3. Варіант Б — Headless API (Власний інтерфейс / Кастомна верстка)

Якщо у вашому застосунку власний дизайн вікна камери та кнопок:

```html
<video id="my-video" playsinline autoplay muted></video>
<button id="btn-switch">🔄 Змінити камеру</button>
<button id="btn-refresh">♻️ Оновити фокус</button>
<button id="btn-torch">🔦 Ліхтарик</button>

<script type="module">
  import { UniversalBarcodeScanner } from './barcode-scanner.js';

  const scanner = new UniversalBarcodeScanner({
    videoElement: document.getElementById('my-video'),
    confirmFrames: 2,          // 1 кадр для QR/Code-128 (завдяки контрольній сумі), 2 для EAN
    duplicateCooldownMs: 2000, // Пауза між дублікатами (мс)
    beepOnScan: true,
    vibrateOnScan: true,
    onScan: ({ value, format, engine, elapsedMs }) => {
      console.log('Код:', value, format, elapsedMs);
    },
    onStatus: (msg) => console.info('[Scanner]', msg),
    onError: (err) => console.error('[Scanner Error]', err)
  });

  // Старт сканера (автоматично обере задню камеру з ліхтариком і 720p/1080p)
  const info = await scanner.start();
  console.log('Активний рушій:', info.engine, 'Підтримка ліхтарика:', Boolean(info.capabilities.torch));

  // Керування:
  document.getElementById('btn-switch').onclick = () => scanner.switchRearCamera();
  document.getElementById('btn-refresh').onclick = () => scanner.refreshCamera();
  document.getElementById('btn-torch').onclick = () => scanner.setTorch(!scanner.torchEnabled);
</script>
```

---

## 4. Приклад використання у React

```tsx
import { useEffect, useRef } from 'react';
import { UniversalBarcodeScanner, ScanResult } from './barcode-scanner';

export function BarcodeScannerModal({ onDetected }: { onDetected: (res: ScanResult) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let instance: UniversalBarcodeScanner | null = null;
    if (containerRef.current) {
      UniversalBarcodeScanner.mount(containerRef.current, {
        onScan: onDetected
      }).then((sc) => {
        instance = sc;
      });
    }
    return () => {
      instance?.destroy?.();
    };
  }, [onDetected]);

  return <div ref={containerRef} />;
}
```

---

## 5. Офлайн / Локальний хостинг WASM (без зовнішніх CDN)

За замовчуванням на пристроях без апаратного `BarcodeDetector` (iOS Safari, Windows, Firefox) SDK автоматично завантажує `zxing-wasm@2.1.2` із jsDelivr CDN. Якщо ваш застосунок працює в закритій локальній мережі без інтернету, покладіть файли `index.js` та `zxing_reader.wasm` із пакета `zxing-wasm` на свій сервер і передайте шляхи:

```js
const scanner = await UniversalBarcodeScanner.mount('#scanner-box', {
  wasmIifeUrl: '/assets/zxing/iife/reader/index.js',
  wasmBinaryDir: '/assets/zxing/reader/',
  onScan: (res) => console.log(res.value)
});
```
