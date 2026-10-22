// 이미지 품질 검사 + 전처리 + Tesseract.js OCR (한국어+영어)
const OCR = (() => {
  let workerPromise;

  function getWorker(onProgress) {
    if (!workerPromise) {
      workerPromise = Tesseract.createWorker('kor+eng', 1, {
        logger: (m) => onProgress && onProgress(m),
      });
    }
    return workerPromise;
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

  // 회색조 + 대비 보정 — 영수증/고지서의 연한 인쇄에 효과적
  async function preprocess(src) {
    const img = await loadImage(src);
    const s = Math.min(2, 2000 / img.width);
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s);
    c.height = Math.round(img.height * s);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const id = ctx.getImageData(0, 0, c.width, c.height);
    const d = id.data;
    let min = 255, max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = Math.max(1, max - min);
    for (let i = 0; i < d.length; i += 4) {
      const v = ((d[i] - min) / range) * 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(id, 0, 0);
    return c;
  }

  async function recognize(src, onProgress) {
    const worker = await getWorker(onProgress);
    const canvas = await preprocess(src);
    const { data } = await worker.recognize(canvas);
    return {
      text: data.text,
      confidence: data.confidence,
      lines: (data.lines || []).map((l) => ({ text: l.text, confidence: l.confidence })),
    };
  }

  return { recognize, quality, downscale };
})();
