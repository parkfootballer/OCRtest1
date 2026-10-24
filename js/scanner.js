// 문서 영역 찾기 + 기울기 보정(원근 변환) + 영역 조정 화면.
// 외부 라이브러리 없이 동작하도록 단순한 방법을 쓴다:
//   밝기 이진화(Otsu) → 가장 큰 밝은 덩어리(= 종이) → 볼록 껍질 → 넓이가 가장 큰 사각형
// 어두운 바탕 위의 흰 종이에서 잘 맞고, 흰 책상 위처럼 대비가 낮으면 못 찾을 수 있다(그때는 안내 틀·수동 조정).
const Scanner = (() => {
  // ---------- 감지 ----------
  // source(video·canvas·img)의 rect 영역을 작게 줄여 문서 꼭짓점을 찾는다. 좌표는 source 기준으로 돌려준다
  function detect(source, rect, maxW = 320) {
    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;
    const r = rect || { x: 0, y: 0, w: sw, h: sh };
    if (!r.w || !r.h) return null;
    const s = Math.min(1, maxW / Math.max(r.w, r.h));
    const w = Math.max(16, Math.round(r.w * s)), h = Math.max(16, Math.round(r.h * s));
    const c = detect.canvas || (detect.canvas = document.createElement('canvas'));
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, w, h);
    const found = findQuad(ctx.getImageData(0, 0, w, h));
    if (!found) return null;
    const kx = r.w / w, ky = r.h / h;
    return { ...found, quad: found.quad.map(([x, y]) => [r.x + x * kx, r.y + y * ky]) };
  }

  function findQuad({ data, width: w, height: h }) {
    const n = w * h;
    let g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    g = boxBlur(boxBlur(g, w, h, 2), w, h, 2); // 글자·잡티를 뭉갠다

    // Otsu 임계값
    const hist = new Float64Array(256);
    for (let i = 0; i < n; i++) hist[Math.min(255, g[i] | 0)]++;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB || wB === n) continue;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / (n - wB);
      const between = wB * (n - wB) * (mB - mF) ** 2;
      if (between > best) { best = between; thr = t; }
    }

    // 가장 큰 밝은 덩어리
    const label = new Int32Array(n).fill(-1);
    const stack = new Int32Array(n);
    let bestComp = null;
    for (let start = 0; start < n; start++) {
      if (label[start] !== -1 || g[start] <= thr) continue;
      let top = 0, count = 0, minX = w, minY = h, maxX = 0, maxY = 0;
      const pts = [];
      stack[top++] = start; label[start] = start;
      while (top) {
        const p = stack[--top];
        const x = p % w, y = (p / w) | 0;
        count++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        let edge = false;
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
          if (q < 0) { edge = true; continue; }
          if (g[q] <= thr) { edge = true; continue; }
          if (label[q] === -1) { label[q] = start; stack[top++] = q; }
        }
        if (edge) pts.push([x, y]);
      }
      if (!bestComp || count > bestComp.count) bestComp = { count, pts, minX, minY, maxX, maxY };
    }
    if (!bestComp || bestComp.count < n * 0.08) return null;

    const hull = convexHull(bestComp.pts);
    if (hull.length < 4) return null;
    const quad = maxQuad(hull);
    const area = polyArea(quad);
    if (!quad || area < n * 0.1 || area > n * 0.985) return null; // 너무 작거나 화면 전체가 밝은 경우
    if (bestComp.count / area < 0.78) return null;                 // 사각형이 아닌 덩어리
    if (!convex(quad)) return null;
    const touches = [bestComp.minX <= 1, bestComp.minY <= 1, bestComp.maxX >= w - 2, bestComp.maxY >= h - 2].filter(Boolean).length;
    return { quad, areaRatio: area / n, touches };
  }

  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, k = 0;
        for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < w) { s += src[y * w + xx]; k++; } }
        tmp[y * w + x] = s / k;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, k = 0;
        for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; k++; } }
        out[y * w + x] = s / k;
      }
    }
    return out;
  }

  function convexHull(points) {
    const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const pt of p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
      lower.push(pt);
    }
    for (let i = p.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
      upper.push(p[i]);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }

  // 볼록 껍질에서 넓이가 가장 큰 사각형: 여러 기울기에서 네 대각 방향의 끝점을 골라 비교한다
  // 반환 순서: 왼쪽 위, 오른쪽 위, 오른쪽 아래, 왼쪽 아래
  function maxQuad(hull) {
    let best = null, bestArea = 0;
    for (let deg = -40; deg <= 40; deg += 4) {
      const corners = [225, 315, 45, 135].map((base) => {
        const a = ((base + deg) * Math.PI) / 180;
        const dx = Math.cos(a), dy = Math.sin(a);
        let bp = hull[0], bv = -Infinity;
        for (const p of hull) { const v = p[0] * dx + p[1] * dy; if (v > bv) { bv = v; bp = p; } }
        return bp;
      });
      const area = polyArea(corners);
      if (area > bestArea) { bestArea = area; best = corners; }
    }
    return best;
  }

  const polyArea = (q) => Math.abs(q.reduce((s, p, i) => { const r = q[(i + 1) % q.length]; return s + p[0] * r[1] - r[0] * p[1]; }, 0)) / 2;
  function convex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(z) < 1e-6) return false;
      if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
    }
    return true;
  }

  // ---------- 원근 변환 ----------
  // 출력 직사각형 (u,v) → 원본 사각형 (x,y) 호모그래피
  function homography(dst, src) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [u, v] = dst[i], [x, y] = src[i];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    // 가우스 소거
    for (let c = 0; c < 8; c++) {
      let p = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
      for (let r = c + 1; r < 8; r++) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const hv = new Array(8);
    for (let r = 7; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < 8; k++) s -= A[r][k] * hv[k];
      hv[r] = s / A[r][r];
    }
    return hv;
  }

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  // quad(원본 좌표)를 펴서 잘라낸 canvas. maxSide: 출력 긴 변 상한
  function warp(img, quad, maxSide = 1800) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    // 원본이 너무 크면 먼저 줄여서 메모리를 아낀다
    const pre = Math.min(1, 2600 / Math.max(iw, ih));
    const sc = document.createElement('canvas');
    sc.width = Math.round(iw * pre); sc.height = Math.round(ih * pre);
    const sctx = sc.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(img, 0, 0, sc.width, sc.height);
    const src = sctx.getImageData(0, 0, sc.width, sc.height);
    const q = quad.map(([x, y]) => [x * pre, y * pre]);

    let W = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
    let H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    const k = Math.min(1, maxSide / Math.max(W, H));
    W = Math.max(8, Math.round(W * k)); H = Math.max(8, Math.round(H * k));
    const hm = homography([[0, 0], [W, 0], [W, H], [0, H]], q);

    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const octx = out.getContext('2d');
    const dst = octx.createImageData(W, H);
    const sd = src.data, dd = dst.data, SW = src.width, SH = src.height;
    for (let v = 0; v < H; v++) {
      for (let u = 0; u < W; u++) {
        const den = hm[6] * u + hm[7] * v + 1;
        let x = (hm[0] * u + hm[1] * v + hm[2]) / den;
        let y = (hm[3] * u + hm[4] * v + hm[5]) / den;
        x = Math.min(SW - 1.001, Math.max(0, x)); y = Math.min(SH - 1.001, Math.max(0, y));
        const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
        const i00 = (y0 * SW + x0) * 4, i01 = i00 + 4, i10 = i00 + SW * 4, i11 = i10 + 4;
        const o = (v * W + u) * 4;
        for (let c = 0; c < 3; c++) {
          dd[o + c] = (sd[i00 + c] * (1 - fx) + sd[i01 + c] * fx) * (1 - fy) + (sd[i10 + c] * (1 - fx) + sd[i11 + c] * fx) * fy;
        }
        dd[o + 3] = 255;
      }
    }
    octx.putImageData(dst, 0, 0);
    return out;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // ---------- 영역 조정 화면 ----------
  // 촬영(또는 앨범) 사진 위에 네 꼭짓점을 보여 주고, 끌어서 조정한 뒤 보정한다.
  // 반환: { dataUrl, corrected } 또는 null(다시 찍기)
  async function editor(dataUrl) {
    const img = await loadImage(dataUrl);
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const auto = detect(img, null, 480);
    const inset = (f) => [[iw * f, ih * f], [iw * (1 - f), ih * f], [iw * (1 - f), ih * (1 - f)], [iw * f, ih * (1 - f)]];
    let quad = auto ? auto.quad : inset(0.04);

    const root = document.createElement('div');
    root.className = 'cropper';
    root.innerHTML = `
      <div class="crop-top">
        <button class="icon-btn" data-act="retake">다시 찍기</button>
        <span>${auto ? '문서 영역을 찾았습니다' : '문서 모서리를 맞춰 주세요'}</span>
        <button class="icon-btn" data-act="reset">${auto ? '자동' : '전체'}</button>
      </div>
      <div class="crop-stage">
        <img src="${dataUrl}" alt="">
        <svg><polygon></polygon></svg>
        ${[0, 1, 2, 3].map((i) => `<i class="h" data-i="${i}"></i>`).join('')}
      </div>
      <p class="crop-hint">모서리 점을 끌어 문서 테두리에 맞추면 기울기를 펴서 잘라냅니다</p>
      <div class="crop-actions">
        <button class="btn ghost" data-act="original">원본 그대로</button>
        <button class="btn primary" data-act="ok">보정해서 사용</button>
      </div>`;
    document.body.appendChild(root);
    const stage = root.querySelector('.crop-stage');
    const im = stage.querySelector('img');
    const poly = stage.querySelector('polygon');
    const handles = [...stage.querySelectorAll('.h')];

    // 화면 표시 영역(contain) ↔ 이미지 좌표
    let view = { x: 0, y: 0, s: 1 };
    function layout() {
      const r = stage.getBoundingClientRect();
      const s = Math.min(r.width / iw, r.height / ih);
      view = { x: (r.width - iw * s) / 2, y: (r.height - ih * s) / 2, s };
      Object.assign(im.style, { left: `${view.x}px`, top: `${view.y}px`, width: `${iw * s}px`, height: `${ih * s}px` });
      draw();
    }
    const toScreen = ([x, y]) => [view.x + x * view.s, view.y + y * view.s];
    function draw() {
      const pts = quad.map(toScreen);
      poly.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
      handles.forEach((hd, i) => { hd.style.left = `${pts[i][0]}px`; hd.style.top = `${pts[i][1]}px`; });
    }
    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      const hd = e.target.closest('.h');
      if (!hd) return;
      drag = +hd.dataset.i;
      hd.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    stage.addEventListener('pointermove', (e) => {
      if (drag == null) return;
      const r = stage.getBoundingClientRect();
      const x = (e.clientX - r.left - view.x) / view.s, y = (e.clientY - r.top - view.y) / view.s;
      quad[drag] = [Math.min(iw, Math.max(0, x)), Math.min(ih, Math.max(0, y))];
      draw();
    });
    const end = () => { drag = null; };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    window.addEventListener('resize', layout);
    layout(); // 바로 한 번, 그리고 레이아웃이 확정된 다음 프레임에 한 번 더
    requestAnimationFrame(layout);

    return new Promise((resolve) => {
      const close = (v) => { window.removeEventListener('resize', layout); root.remove(); resolve(v); };
      root.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        if (act === 'retake') close(null);
        else if (act === 'reset') { quad = auto ? auto.quad.map((p) => p.slice()) : inset(0); draw(); }
        else if (act === 'original') close({ dataUrl, corrected: false });
        else if (act === 'ok') {
          if (!convex(quad)) { root.querySelector('.crop-hint').textContent = '꼭짓점이 꼬였습니다. 네 모서리를 순서대로 맞춰 주세요'; return; }
          root.querySelector('.crop-hint').textContent = '보정하는 중…';
          setTimeout(() => close({ dataUrl: warp(img, quad).toDataURL('image/jpeg', 0.9), corrected: true }), 30);
        }
      });
    });
  }

  return { detect, warp, editor, loadImage, convex };
})();
