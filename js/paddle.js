// PaddleOCR(ONNX) 글자 인식 — 브라우저(onnxruntime-web)와 Node(onnxruntime-node) 공용.
// 이미지는 { data: RGBA Uint8(Clamped)Array, width, height } 형태로 받는다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaddleOCR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DET_MEAN = [0.485, 0.456, 0.406];
  const DET_STD = [0.229, 0.224, 0.225];
  const REC_H = 48;
  const REC_MIN_W = 320;

  // 원본 RGBA의 (sx, sy, sw, sh) 영역을 dw×dh로 양선형 보간해 BGR planar Float32로 만든다
  function sampleBGR(img, sx, sy, sw, sh, dw, dh, norm, outW = dw) {
    const { data, width, height } = img;
    const out = new Float32Array(3 * dh * outW);
    const plane = dh * outW;
    const fx = sw / dw, fy = sh / dh;
    for (let y = 0; y < dh; y++) {
      const syf = Math.min(height - 1, Math.max(0, sy + (y + 0.5) * fy - 0.5));
      const y0 = Math.floor(syf), y1 = Math.min(height - 1, y0 + 1), wy = syf - y0;
      for (let x = 0; x < dw; x++) {
        const sxf = Math.min(width - 1, Math.max(0, sx + (x + 0.5) * fx - 0.5));
        const x0 = Math.floor(sxf), x1 = Math.min(width - 1, x0 + 1), wx = sxf - x0;
        const i00 = (y0 * width + x0) * 4, i01 = (y0 * width + x1) * 4;
        const i10 = (y1 * width + x0) * 4, i11 = (y1 * width + x1) * 4;
        const o = y * outW + x;
        for (let c = 0; c < 3; c++) {
          const v = (data[i00 + c] * (1 - wx) + data[i01 + c] * wx) * (1 - wy)
                  + (data[i10 + c] * (1 - wx) + data[i11 + c] * wx) * wy;
          out[(2 - c) * plane + o] = norm(v, 2 - c); // RGB → BGR
        }
      }
    }
    return out;
  }

  async function create({ ort, detModel, recModel, dictText, detLimit = 1600, sessionOptions }) {
    const [det, rec] = await Promise.all([
      ort.InferenceSession.create(detModel, sessionOptions),
      ort.InferenceSession.create(recModel, sessionOptions),
    ]);
    const chars = dictText.replace(/\r/g, '').split('\n');
    if (chars[chars.length - 1] === '') chars.pop();

    // ---------- 글자 영역 찾기 (DB 알고리즘 후처리) ----------
    async function detect(img, { thresh = 0.3, boxThresh = 0.55, unclip = 1.6 } = {}) {
      const { width: W, height: H } = img;
      const s = Math.min(1, detLimit / Math.max(W, H));
      const rw = Math.max(32, Math.round((W * s) / 32) * 32);
      const rh = Math.max(32, Math.round((H * s) / 32) * 32);
      const input = sampleBGR(img, 0, 0, W, H, rw, rh, (v, c) => (v / 255 - DET_MEAN[c]) / DET_STD[c]);
      const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, rh, rw]) });
      const prob = out[det.outputNames[0]].data;

      const seen = new Uint8Array(rw * rh);
      const stack = new Int32Array(rw * rh);
      const boxes = [];
      for (let start = 0; start < rw * rh; start++) {
        if (seen[start] || prob[start] <= thresh) continue;
        let top = 0, n = 0, sum = 0;
        let minX = rw, minY = rh, maxX = 0, maxY = 0;
        stack[top++] = start; seen[start] = 1;
        while (top) {
          const p = stack[--top];
          const x = p % rw, y = (p / rw) | 0;
          n++; sum += prob[p];
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (x > 0 && !seen[p - 1] && prob[p - 1] > thresh) { seen[p - 1] = 1; stack[top++] = p - 1; }
          if (x < rw - 1 && !seen[p + 1] && prob[p + 1] > thresh) { seen[p + 1] = 1; stack[top++] = p + 1; }
          if (y > 0 && !seen[p - rw] && prob[p - rw] > thresh) { seen[p - rw] = 1; stack[top++] = p - rw; }
          if (y < rh - 1 && !seen[p + rw] && prob[p + rw] > thresh) { seen[p + rw] = 1; stack[top++] = p + rw; }
        }
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        if (Math.min(bw, bh) < 3 || sum / n < boxThresh) continue;
        // 수축된 글자 영역을 원래 크기로 넓힌다 (DB unclip)
        const d = (bw * bh * unclip) / (2 * (bw + bh));
        const kx = W / rw, ky = H / rh;
        boxes.push([
          Math.max(0, (minX - d) * kx), Math.max(0, (minY - d) * ky),
          Math.min(W, (maxX + 1 + d) * kx), Math.min(H, (maxY + 1 + d) * ky),
        ]);
      }
      return boxes;
    }

    // ---------- 글자 읽기 (CTC) — 비슷한 너비의 상자를 묶어 한 번에 추론 ----------
    const recWidth = ([x0, y0, x1, y1]) => Math.max(8, Math.min(2400, Math.ceil((REC_H * (x1 - x0)) / (y1 - y0))));
    async function recognizeBatch(img, boxes) {
      const outW = Math.max(REC_MIN_W, ...boxes.map(recWidth));
      const plane = 3 * REC_H * outW;
      const input = new Float32Array(boxes.length * plane);
      boxes.forEach((b, k) => {
        input.set(sampleBGR(img, b[0], b[1], b[2] - b[0], b[3] - b[1], recWidth(b), REC_H, (v) => v / 127.5 - 1, outW), k * plane);
      });
      const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', input, [boxes.length, 3, REC_H, outW]) });
      const t = out[rec.outputNames[0]];
      const [, T, C] = t.dims;
      const p = t.data;
      return boxes.map((_, k) => {
        let text = '', last = 0, confSum = 0, confN = 0;
        for (let i = 0; i < T; i++) {
          const o = (k * T + i) * C;
          let best = 0, bv = -Infinity;
          for (let c = 0; c < C; c++) { const v = p[o + c]; if (v > bv) { bv = v; best = c; } }
          if (best !== 0 && best !== last) {
            text += best - 1 < chars.length ? chars[best - 1] : ' ';
            confSum += bv; confN++;
          }
          last = best;
        }
        return { text: text.trim(), confidence: confN ? (confSum / confN) * 100 : 0 };
      });
    }
    async function recognizeAll(img, boxes, onProgress, batch = 8) {
      // 너비 순으로 묶어 빈칸(padding) 계산을 줄인다
      const order = boxes.map((b, i) => i).sort((a, b) => recWidth(boxes[a]) - recWidth(boxes[b]));
      const res = new Array(boxes.length);
      for (let s = 0; s < order.length; s += batch) {
        const idx = order.slice(s, s + batch);
        const out = await recognizeBatch(img, idx.map((i) => boxes[i]));
        idx.forEach((i, k) => { res[i] = out[k]; });
        if (onProgress) onProgress(Math.min(1, (s + batch) / order.length));
      }
      return res;
    }
    const recognize = async (img, box) => (await recognizeBatch(img, [box]))[0];

    // ---------- 방향 보정 ----------
    function rotate(img, deg) {
      const { data, width: W, height: H } = img;
      const vertical = deg === 90 || deg === 270;
      const nw = vertical ? H : W, nh = vertical ? W : H;
      const out = new Uint8ClampedArray(nw * nh * 4);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          let nx, ny;
          if (deg === 90) { nx = H - 1 - y; ny = x; }        // 시계 방향 90°
          else if (deg === 270) { nx = y; ny = W - 1 - x; }  // 반시계 90°
          else { nx = W - 1 - x; ny = H - 1 - y; }           // 180°
          const si = (y * W + x) * 4, di = (ny * nw + nx) * 4;
          out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = 255;
        }
      }
      return { data: out, width: nw, height: nh };
    }
    // 큰 상자 몇 개만 읽어 평균 신뢰도로 방향을 판단
    async function sampleConf(img, boxes) {
      const big = [...boxes].sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1])).slice(0, 8);
      if (!big.length) return 0;
      const r = await recognizeBatch(img, big);
      return r.reduce((s, x) => s + x.confidence, 0) / r.length;
    }
    async function orient(img) {
      let boxes = await detect(img);
      const tall = boxes.filter((b) => b[3] - b[1] > (b[2] - b[0]) * 1.5).length;
      if (boxes.length >= 4 && tall > boxes.length * 0.5) {
        let best = null;
        for (const deg of [90, 270]) {
          const im = rotate(img, deg);
          const bx = await detect(im);
          const conf = await sampleConf(im, bx);
          if (!best || conf > best.conf) best = { img: im, boxes: bx, conf, deg };
        }
        return best;
      }
      const conf0 = await sampleConf(img, boxes);
      if (conf0 < 75) {
        const im = rotate(img, 180);
        const bx = await detect(im);
        const conf = await sampleConf(im, bx);
        if (conf > conf0 + 10) return { img: im, boxes: bx, conf, deg: 180 };
      }
      return { img, boxes, conf: conf0, deg: 0 };
    }

    // 상자들을 같은 높이끼리 줄로 묶는다. 칸 사이가 넓으면 공백 두 칸으로 이어 표의 칸 구분을 남긴다
    function toLines(words) {
      const sorted = [...words].sort((a, b) => (a.box[1] + a.box[3]) - (b.box[1] + b.box[3]));
      const rows = [];
      for (const w of sorted) {
        const cy = (w.box[1] + w.box[3]) / 2, h = w.box[3] - w.box[1];
        const row = rows.find((r) => Math.abs(r.cy - cy) < Math.min(r.h, h) * 0.5);
        if (row) { row.words.push(w); row.cy = (row.cy * (row.words.length - 1) + cy) / row.words.length; }
        else rows.push({ cy, h, words: [w] });
      }
      return rows.sort((a, b) => a.cy - b.cy).map((r) => {
        const ws = r.words.sort((a, b) => a.box[0] - b.box[0]);
        let text = '';
        ws.forEach((w, i) => {
          if (i) text += w.box[0] - ws[i - 1].box[2] > r.h * 0.9 ? '  ' : ' ';
          text += w.text;
        });
        const confidence = ws.reduce((s, w) => s + w.confidence, 0) / ws.length;
        const box = [Math.min(...ws.map((w) => w.box[0])), Math.min(...ws.map((w) => w.box[1])),
          Math.max(...ws.map((w) => w.box[2])), Math.max(...ws.map((w) => w.box[3]))];
        return { text, confidence, box, words: ws };
      });
    }

    // 전체: 이미지 → { text, confidence, lines, words, rotation }
    // rotation: 바로 세우려고 돌린 각도(시계 방향). 상자 좌표는 돌린 이미지 기준
    async function run(img, onProgress) {
      const o = await orient(img);
      const res = await recognizeAll(o.img, o.boxes, onProgress);
      const words = [];
      res.forEach((r, i) => { if (r.text) words.push({ ...r, box: o.boxes[i].map((v) => Math.round(v)) }); });
      const lines = toLines(words);
      const confidence = words.length ? words.reduce((s, w) => s + w.confidence, 0) / words.length : 0;
      return {
        text: lines.map((l) => l.text).join('\n'), confidence, lines, words,
        width: o.img.width, height: o.img.height, rotation: o.deg,
      };
    }

    return { run, detect, recognize, toLines, rotate };
  }

  return { create };
});
