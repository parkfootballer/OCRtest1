// 이미지 품질 검사 + PaddleOCR(ONNX, 휴대폰 CPU에서 실행) 글자 인식
const OCR = (() => {
  const MODEL_BASE = '/models/';
  let enginePromise;

  // 모델은 처음 한 번만 받고(약 16MB) 서비스 워커가 휴대폰에 저장해 둔다
  async function fetchModel(url, onProgress, label) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`인식 모델을 받지 못했습니다 (${res.status})`);
    const total = +res.headers.get('Content-Length') || 0;
    if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const buf = new Uint8Array(total);
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf.set(value, got);
      got += value.length;
      if (onProgress) onProgress({ status: label, progress: got / total });
    }
    return buf;
  }

  function getEngine(onProgress) {
    if (!enginePromise) {
      enginePromise = (async () => {
        ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
        // 교차 출처 격리가 된 브라우저(안드로이드 크롬 등)에서만 멀티스레드 사용
        ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
        const [det, rec, dict] = await Promise.all([
          fetchModel(MODEL_BASE + 'det.onnx', onProgress, '글자 위치 모델 받는 중'),
          fetchModel(MODEL_BASE + 'rec_korean.onnx', onProgress, '한국어 인식 모델 받는 중'),
          fetch(MODEL_BASE + 'dict_korean.txt').then((r) => r.text()),
        ]);
        return PaddleOCR.create({
          ort, detModel: det, recModel: rec, dictText: dict,
          sessionOptions: { executionProviders: ['wasm'], graphOptimizationLevel: 'all' },
        });
      })().catch((e) => { enginePromise = null; throw e; });
    }
    return enginePromise;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // 큰 사진을 줄여 저장용 dataURL을 만든다
  async function downscale(src, maxSide = 1800, quality = 0.85) {
    const img = await loadImage(src);
    const s = Math.min(1, maxSide / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s);
    c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }

  // 밝기 평균과 라플라시안 분산(선명도)으로 촬영 품질을 빠르게 판단
  async function quality(src) {
    const img = await loadImage(src);
    const w = 400, h = Math.round((img.height / img.width) * 400);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    let sum = 0;
    for (let i = 0; i < w * h; i++) {
      g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
      sum += g[i];
    }
    const brightness = sum / (w * h);
    let lapSum = 0, lapSq = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
        lapSum += l; lapSq += l * l; n++;
      }
    }
    const sharpness = lapSq / n - (lapSum / n) ** 2;
    const issues = [];
    if (brightness < 60) issues.push('너무 어둡습니다');
    if (brightness > 235) issues.push('빛 반사가 심합니다');
    if (sharpness < 40) issues.push('초점이 흐립니다');
    return { brightness, sharpness, issues };
  }

  // 사진 → RGBA 픽셀 (너무 크면 긴 변 2400px로 줄임)
  async function pixels(src, maxSide = 2400) {
    const img = await loadImage(src);
    const s = Math.min(1, maxSide / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s);
    c.height = Math.round(img.height * s);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  // 인식 결과 형식: { text, confidence, lines:[{text, confidence, box, words}], words, rotation }
  async function recognize(src, onProgress) {
    const engine = await getEngine(onProgress);
    const img = await pixels(src);
    return engine.run(img, (p) => onProgress && onProgress({ status: '글자 인식 중', progress: p }));
  }

  // OCR이 문서를 돌려 읽었으면(rotation°) 저장용 사진도 같은 방향으로 바로 세운다
  async function rotateDataUrl(src, deg, quality = 0.85) {
    const img = await loadImage(src);
    const vertical = deg === 90 || deg === 270;
    const c = document.createElement('canvas');
    c.width = vertical ? img.height : img.width;
    c.height = vertical ? img.width : img.height;
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    return c.toDataURL('image/jpeg', quality);
  }

  // 화면을 띄우자마자 모델을 미리 받아 두면 첫 촬영이 빨라진다
  const warmup = () => getEngine().catch(() => {});

  // 학습 데이터에 남기는 엔진·모델 식별자 (models/README.md의 SHA-256 앞 8자리). 모델을 바꾸면 함께 바꾼다
  const ENGINE = 'paddleocr-onnx';
  const MODEL_VERSION = 'det:PP-OCRv3-mobile@ee40e800+rec:korean-PP-OCRv5-mobile@322f1401';

  // recognize() 결과에서 서버에 저장할 부분만 (글자·신뢰도·상자). 상자 좌표는 바로 세운 이미지 기준
  function toStored(ocr) {
    const pick = (x) => ({ text: x.text, confidence: Math.round(x.confidence * 10) / 10, box: x.box });
    return {
      width: ocr.width, height: ocr.height, rotation: ocr.rotation, confidence: Math.round(ocr.confidence * 10) / 10,
      lines: ocr.lines.map(pick), words: ocr.words.map(pick),
    };
  }

  return { recognize, quality, downscale, rotateDataUrl, warmup, toStored, ENGINE, MODEL_VERSION };
})();
