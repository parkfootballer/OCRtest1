// 화면 라우팅과 촬영 → 인식 → 대조 → 검수 흐름
(() => {
  const $view = document.getElementById('view');
  const $tabbar = document.getElementById('tabbar');
  const fmt = Parser.fmt;
  let user;
  let stream; // 카메라 MediaStream
  let camTimer; // 문서 테두리 감지 타이머
  let onCamResize; // 안내 틀 다시 맞추기

  const STATUS = {
    processing: ['인식 중', 'st-proc'],
    needs_retake: ['재촬영 필요', 'st-retake'],
    needs_review: ['검수 대기', 'st-review'],
    verified: ['완료', 'st-ok'],
  };
  const FIELDS = [
    ['vendorName', '상호(업체명)', 'text'],
    ['businessNumber', '사업자등록번호', 'text'],
    ['documentNumber', '문서번호', 'text'],
    ['issueDate', '발행일', 'date'],
    ['dueDate', '납부기한', 'date'],
    ['totalAmount', '합계 금액', 'money'],
    ['taxAmount', '세액', 'money'],
    ['customerName', '고객명(공급받는자)', 'text'],
    ['billingMonth', '청구년월', 'month'],
  ];
  const AUTO_VERIFY_SCORE = 0.85;
  // 수량·단가가 모두 있을 때만 수량×단가=금액을 따진다 (고지서 항목은 금액만 있음)
  const itemMismatch = (it) => it.quantity != null && it.quantity !== '' && it.unitPrice != null && it.unitPrice !== ''
    && Math.abs((+it.quantity) * (+it.unitPrice) - (+it.amount || 0)) > 1;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const h = (html) => { $view.innerHTML = html; $view.scrollTop = 0; };

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function badge(status) {
    const [label, cls] = STATUS[status] || [status, ''];
    return `<span class="badge ${cls}">${label}</span>`;
  }
  const typeLabel = (t) => Parser.DOC_TYPES[t] || t;
  // 업장 표시: "업장코드 · 업장명" (업장코드가 없는 예전 업장은 호텔명)
  const wpLabel = (w) => `${w.code || w.hotelName} · ${w.name}`;
  const dateLabel = (iso) => new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const qtyLabel = (n) => (n == null ? '' : Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 3 }));
  const INVENTORY_TYPES = ['invoice', 'tax_invoice']; // 비품 구매 문서 → 재고 반영

  // ---------- 확인 창 ----------
  // actions: [{ label, value, cls }] → 누른 버튼의 value (바깥을 누르면 null)
  function dialog({ title, body = '', actions }) {
    return new Promise((resolve) => {
      const root = document.createElement('div');
      root.className = 'modal';
      root.innerHTML = `
        <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <h2>${esc(title)}</h2>
          <div class="sheet-body">${body}</div>
          <div class="sheet-actions">${actions.map((a, i) =>
            `<button class="btn ${a.cls || 'ghost'}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>
        </div>`;
      document.body.appendChild(root);
      root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-i]');
        if (!b && e.target !== root) return;
        root.remove();
        resolve(b ? actions[+b.dataset.i].value : null);
      });
      root.querySelector('.sheet-actions .btn:last-child')?.focus();
    });
  }

  // 원본 파일 SHA-256 — "같은 파일" 중복 판단에 쓴다 (보안 컨텍스트가 아니면 건너뜀)
  async function sha256Hex(input) {
    if (!crypto?.subtle) return null;
    let buf = input;
    if (typeof input === 'string') buf = await (await fetch(input)).arrayBuffer(); // dataURL
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // 중복 경고: 기존 문서 정보와 함께 선택지를 보여 준다
  // 반환: { decision: 'cancel' | 'duplicate' | 'distinct', duplicateOf }
  async function duplicateDialog(dups, { stage }) {
    const exact = dups.some((d) => d.level === 'exact');
    const first = dups.find((d) => d.level === 'exact') || dups[0];
    const body = `
      <p class="dup-lead">${exact ? '이미 등록된 문서와 <b>정확히 일치</b>합니다.' : '이미 등록된 문서와 <b>일부 정보가 같습니다</b>. 같은 문서인지 확인해 주세요.'}</p>
      <ul class="dup-list">${dups.map((d) => `
        <li class="${d.level}">
          ${d.document.imageUrl ? `<img src="${d.document.imageUrl}" alt="">` : ''}
          <div>
            <span class="dup-level">${d.level === 'exact' ? '정확히 일치' : '중복 가능성'}</span>
            <b>${esc(d.document.vendorName || '상호 미확인')}</b>
            <small>${typeLabel(d.document.documentType)} · ${d.document.issueDate || d.document.billingMonth || '날짜 미확인'}
              · ${d.document.totalAmount != null ? fmt(d.document.totalAmount) + '원' : '금액 미확인'}</small>
            <small>${d.document.documentNumber ? `문서번호 ${esc(d.document.documentNumber)} · ` : ''}${dateLabel(d.document.createdAt)} 등록 · ${STATUS[d.document.status]?.[0] || ''}</small>
            <span class="chips">${d.reasons.map((r) => `<em>${esc(r)}</em>`).join('')}</span>
          </div>
        </li>`).join('')}</ul>
      <p class="muted">중복으로 등록하면 문서는 보관되지만 <b>재고에는 반영되지 않습니다</b>.</p>`;
    const actions = [{ label: stage === 'review' ? '돌아가서 수정' : '등록 취소', value: 'cancel' }];
    if (!exact) actions.push({ label: '다른 문서예요 (별개 등록)', value: 'distinct' });
    actions.push({ label: '중복으로 등록', value: 'duplicate', cls: 'primary' });
    const decision = (await dialog({ title: exact ? '중복 문서입니다' : '중복일 수 있습니다', body, actions })) || 'cancel';
    return { decision, duplicateOf: first.document.id };
  }

  // 문서 삭제 확인 → 삭제 (연결된 OCR 결과·학습 데이터·재고 반영까지)
  async function confirmDelete(id, b) {
    b = b || (await DB.documentBundle(id));
    if (!b) return false;
    const inv = b.inventory || [];
    const body = `
      <p>이 문서와 연결된 데이터가 모두 삭제되며 되돌릴 수 없습니다.</p>
      <ul class="del-list">
        <li>촬영 이미지</li>
        <li>OCR 인식 결과·추출 정보${b.items?.length ? ` (품목 ${b.items.length}개)` : ''}</li>
        ${b.logs?.length ? `<li>검수 기록 ${b.logs.length}건</li>` : ''}
        ${b.training ? '<li>학습용 검수 데이터</li>' : ''}
        ${inv.length ? `<li class="warn">재고에서 되돌림: ${inv.map((m) => `${esc(m.name)} ${qtyLabel(m.quantity)}${esc(m.unit || '')}`).join(', ')}</li>` : ''}
      </ul>`;
    const ok = await dialog({
      title: '문서를 삭제할까요?', body,
      actions: [{ label: '취소', value: false }, { label: '삭제', value: true, cls: 'danger-fill' }],
    });
    if (!ok) return false;
    const r = await DB.deleteDocument(id);
    await refreshBadge();
    toast(r?.revertedItems?.length ? `삭제했습니다 · 재고 ${r.revertedItems.length}개 품목 되돌림` : '삭제했습니다');
    return true;
  }

  async function refreshBadge() {
    const list = await DB.listDocuments();
    const n = list.filter((x) => x.doc.status === 'needs_review' || x.doc.status === 'needs_retake').length;
    const b = document.getElementById('queueBadge');
    b.hidden = !n;
    b.textContent = n;
  }

  // ---------- 문서함 / 검수함 ----------
  async function renderList(mode) {
    const list = await DB.listDocuments();
    const count = (s) => list.filter((x) => x.doc.status === s).length;
    const items = mode === 'queue'
      ? list.filter((x) => x.doc.status === 'needs_review' || x.doc.status === 'needs_retake')
      : list;
    const verifiedTotal = list.filter((x) => x.doc.status === 'verified').reduce((s, x) => s + (x.ex?.totalAmount || 0), 0);

    h(`
      <header class="top">
        <h1>${mode === 'queue' ? '검수함' : '문서함'}<small class="wp">${esc(wpLabel(user.workplace))}</small></h1>
        ${mode === 'queue' ? '' : `<a class="avatar" href="#/me" aria-label="내 정보">${esc((user.name || '?').slice(0, 1))}</a>`}
      </header>
      ${mode !== 'queue' && installState() !== 'installed' && installState() !== 'unsupported' ? `
      <a class="install-banner" href="#/me"><img src="/icons/icon-192.png" alt=""><span><b>홈 화면에 앱 설치</b><small>앱처럼 바로 열고 카메라를 쓸 수 있어요</small></span>›</a>` : ''}
      ${mode === 'queue' ? '' : `
      <section class="stats">
        <div><b>${list.length}</b><span>전체</span></div>
        <div><b>${count('needs_review')}</b><span>검수 대기</span></div>
        <div><b>${count('needs_retake')}</b><span>재촬영</span></div>
        <div><b>${count('verified')}</b><span>완료</span></div>
      </section>
      <p class="sum">확정된 금액 합계 <b>${fmt(verifiedTotal)}원</b></p>`}
      <ul class="doclist">
        ${items.map(({ doc, ex }) => `
          <li><a href="#/${doc.status === 'needs_retake' ? 'retake' : 'review'}/${doc.id}">
            <img src="${doc.imageUrl}" alt="" loading="lazy">
            <div class="meta">
              <div class="row1"><b>${esc(ex?.vendorName || '상호 미확인')}</b>${badge(doc.status)}</div>
              <div class="row2">${typeLabel(doc.documentType)} · ${dateLabel(doc.createdAt)}${doc.uploaderName ? ` · ${esc(doc.uploaderName)}` : ''}${doc.duplicateDecision === 'duplicate' ? ' · <span class="dup-tag">중복</span>' : ''}</div>
              <div class="row3">${ex?.totalAmount != null ? fmt(ex.totalAmount) + '원' : '금액 미확인'}
                ${ex ? `<span class="conf">신뢰도 ${Math.round(ex.confidenceScore * 100)}%</span>` : ''}</div>
            </div>
          </a></li>`).join('')}
      </ul>
      ${items.length ? '' : `
        <div class="empty">
          <div class="empty-ico">${mode === 'queue' ? '✓' : '📄'}</div>
          <p>${mode === 'queue' ? '검수할 문서가 없습니다.' : '아직 촬영한 문서가 없습니다.'}</p>
          ${mode === 'queue' ? '' : '<a class="btn primary" href="#/camera">첫 문서 촬영하기</a>'}
        </div>`}
    `);
  }

  // ---------- 촬영 ----------
  async function renderCamera(params) {
    const retakeId = params.get('retake');
    let docType = params.get('type') || 'auto';
    document.body.classList.add('dark');
    OCR.warmup(); // 촬영하는 동안 인식 모델을 미리 받아 둔다
    h(`
      <div class="camera">
        <div class="viewport" id="viewport"><video id="video" playsinline muted autoplay></video></div>
        <div class="frame" id="frame"><i></i><i></i><i></i><i></i></div>
        <svg class="doc-outline" id="outline" aria-hidden="true"><polygon></polygon></svg>
        <div class="cam-top" id="camTop">
          <a href="#/" class="icon-btn" aria-label="닫기">✕</a>
          <span class="cam-title">${retakeId ? '재촬영' : '문서 촬영'}</span>
          <button class="icon-btn" id="sampleBtn" title="문서 예시 보기">샘플</button>
        </div>
        <div class="cam-hint" id="camHint">문서의 네 모서리를 안내 틀 안에 맞춰 주세요</div>
        <div class="cam-bottom" id="camBottom">
          <div class="zoom-ctl" id="zoomCtl" hidden>
            <button data-z="-" aria-label="축소">−</button>
            <span id="zoomLbl">1.0×</span>
            <button data-z="+" aria-label="확대">＋</button>
            <button class="zoom-auto" id="zoomAuto" hidden>자동 줌</button>
          </div>
          <div class="types">${Object.entries(Parser.DOC_TYPES).map(([k, v]) =>
            `<button data-type="${k}" class="${k === docType ? 'on' : ''}">${v}</button>`).join('')}</div>
          <div class="controls">
            <label class="icon-btn lg" aria-label="앨범에서 선택">🖼<input type="file" accept="image/*" id="fileInput" hidden></label>
            <button class="shutter" id="shutter" aria-label="촬영"></button>
            <label class="icon-btn lg" aria-label="기본 카메라 앱">📷<input type="file" accept="image/*" capture="environment" id="nativeInput" hidden></label>
          </div>
        </div>
        <div class="sample-sheet" id="sampleSheet" hidden>
          <p>이런 문서를 촬영할 수 있어요</p>
          <button data-sample="invoice">거래명세서 샘플</button>
          <button data-sample="giro">지로 고지서 샘플</button>
          <button class="ghost" data-sample="">취소</button>
        </div>
        <div class="sample-view" id="sampleView" hidden>
          <div class="sample-view-top">
            <span id="sampleTitle"></span>
            <button class="icon-btn" id="sampleClose" aria-label="닫기">✕</button>
          </div>
          <div class="sample-view-img"><img id="sampleImg" alt=""></div>
          <p class="sample-view-hint">예시 이미지입니다. 저장되거나 인식되지 않습니다. 두 번 탭하면 확대됩니다</p>
        </div>
      </div>
    `);

    const cam = $view.querySelector('.camera');
    const video = document.getElementById('video');
    const viewport = document.getElementById('viewport');
    const frame = document.getElementById('frame');
    const outline = document.getElementById('outline');
    const poly = outline.querySelector('polygon');
    const hint = document.getElementById('camHint');
    const zoomLbl = document.getElementById('zoomLbl');
    const zoomAutoBtn = document.getElementById('zoomAuto');

    // 안내 틀: 위아래 조작부를 뺀 남은 화면에 A4 세로 비율로 최대한 크게 맞춘다
    function layoutFrame() {
      const R = cam.getBoundingClientRect();
      const top = document.getElementById('camTop').getBoundingClientRect().bottom - R.top + 34;
      const bottom = document.getElementById('camBottom').getBoundingClientRect().top - R.top - 12;
      const availW = R.width * 0.9, availH = Math.max(80, bottom - top);
      const ratio = 1.414;
      const w = Math.min(availW, availH / ratio), hgt = w * ratio;
      Object.assign(frame.style, {
        left: `${(R.width - w) / 2}px`, top: `${top + (availH - hgt) / 2}px`, width: `${w}px`, height: `${hgt}px`,
      });
      outline.setAttribute('viewBox', `0 0 ${R.width} ${R.height}`);
    }
    layoutFrame();
    onCamResize = layoutFrame;
    window.addEventListener('resize', layoutFrame);

    // ---- 줌: 카메라가 지원하면 실제 광학/센서 줌, 아니면 미리보기 확대(디지털 줌 = 가운데 잘라내기) ----
    let track = null, hwZoom = null, zoom = 1, autoZoom = false;
    const zoomRange = () => (hwZoom ? [hwZoom.min, Math.min(hwZoom.max, 4)] : [1, 3]);
    function setZoom(z) {
      const [lo, hi] = zoomRange();
      zoom = Math.min(hi, Math.max(lo, z));
      if (hwZoom) track.applyConstraints({ advanced: [{ zoom }] }).catch(() => {});
      else video.style.transform = `scale(${zoom})`;
      zoomLbl.textContent = `${zoom.toFixed(1)}×`;
    }
    $view.querySelectorAll('[data-z]').forEach((b) => b.addEventListener('click', () => {
      autoZoom = false;
      zoomAutoBtn.classList.remove('on');
      setZoom(zoom * (b.dataset.z === '+' ? 1.25 : 0.8));
    }));
    zoomAutoBtn.addEventListener('click', () => {
      autoZoom = !autoZoom;
      zoomAutoBtn.classList.toggle('on', autoZoom);
    });

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } }, audio: false,
      });
      video.srcObject = stream;
      track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.zoom && caps.zoom.max > caps.zoom.min) {
        hwZoom = caps.zoom;
        zoom = track.getSettings().zoom || hwZoom.min;
        autoZoom = true; // 지원하는 카메라에서만 자동 줌
        zoomAutoBtn.hidden = false;
        zoomAutoBtn.classList.add('on');
      }
      zoomLbl.textContent = `${zoom.toFixed(1)}×`;
      document.getElementById('zoomCtl').hidden = false;
    } catch (e) {
      hint.textContent = '카메라를 사용할 수 없습니다. 앨범 또는 샘플을 이용하세요.';
      document.getElementById('shutter').disabled = true;
    }

    // 화면에 보이는 부분(object-fit: cover + 디지털 줌)을 영상 좌표로
    function visibleRect() {
      const W = viewport.clientWidth, H = viewport.clientHeight, VW = video.videoWidth, VH = video.videoHeight;
      const s = Math.max(W / VW, H / VH), ox = (W - VW * s) / 2, oy = (H - VH * s) / 2;
      const z = hwZoom ? 1 : zoom;
      const toV = (sx, sy) => [((sx - W / 2) / z + W / 2 - ox) / s, ((sy - H / 2) / z + H / 2 - oy) / s];
      const [x0, y0] = toV(0, 0), [x1, y1] = toV(W, H);
      const x = Math.max(0, x0), y = Math.max(0, y0);
      return { x, y, w: Math.min(VW, x1) - x, h: Math.min(VH, y1) - y, s, ox, oy, z, W, H };
    }
    const toScreen = (r, [x, y]) => [r.W / 2 + (x * r.s + r.ox - r.W / 2) * r.z, r.H / 2 + (y * r.s + r.oy - r.H / 2) * r.z];

    // ---- 문서 테두리 감지: 0.3초마다 작은 화면으로 찾아 윤곽선과 안내 문구를 보여 준다 ----
    let shown = null, smallN = 0, edgeN = 0, noneN = 0, paused = false;
    function tick() {
      if (paused || !video.videoWidth || document.hidden) return;
      const r = visibleRect();
      const found = Scanner.detect(video, r, 240);
      let state = 'none';
      if (found) {
        state = found.touches >= 2 || found.areaRatio > 0.92 ? 'far' : found.areaRatio < 0.28 ? 'near' : 'good';
        const pts = found.quad.map((p) => toScreen(r, p));
        shown = shown ? shown.map((p, i) => [p[0] * 0.5 + pts[i][0] * 0.5, p[1] * 0.5 + pts[i][1] * 0.5]) : pts; // 떨림 완화
        poly.setAttribute('points', shown.map((p) => p.map(Math.round).join(',')).join(' '));
      } else shown = null;
      outline.dataset.state = state;
      frame.classList.toggle('dim', state === 'good');
      hint.textContent = {
        none: '문서의 네 모서리를 안내 틀 안에 맞춰 주세요',
        far: '문서가 화면을 벗어났어요. 조금 멀리서 찍어 주세요',
        near: '조금 더 가까이 가져가 주세요',
        good: '좋아요! 그대로 촬영하세요',
      }[state];
      hint.classList.toggle('good', state === 'good');

      if (!hwZoom || !autoZoom) return;
      smallN = state === 'near' && found.touches === 0 ? smallN + 1 : 0;
      edgeN = state === 'far' ? edgeN + 1 : 0;
      noneN = state === 'none' ? noneN + 1 : 0;
      if (smallN >= 4 && zoom < Math.min(hwZoom.max, 3)) { setZoom(zoom * 1.12); smallN = 0; }
      else if ((edgeN >= 3 || noneN >= 10) && zoom > hwZoom.min) { setZoom(zoom / 1.12); edgeN = 0; noneN = 0; }
    }
    camTimer = setInterval(tick, 300);

    $view.querySelectorAll('.types button').forEach((b) => b.addEventListener('click', () => {
      docType = b.dataset.type;
      $view.querySelectorAll('.types button').forEach((x) => x.classList.toggle('on', x === b));
    }));

    // 촬영·선택한 사진 → 영역 조정(기울기 보정·잘라내기) → 중복 확인 → 등록
    const go = async (dataUrl, { hashSource } = {}) => {
      paused = true;
      try {
        const r = await Scanner.editor(dataUrl);
        if (!r) return; // 다시 찍기
        await capture(r.dataUrl, docType, retakeId, await sha256Hex(hashSource ?? dataUrl).catch(() => null));
      } finally {
        paused = false;
        cam.classList.remove('flash');
      }
    };

    document.getElementById('shutter').addEventListener('click', () => {
      if (!video.videoWidth) return;
      const r = visibleRect(); // 화면에 보이는 영역만 (디지털 줌 포함)
      const c = document.createElement('canvas');
      c.width = Math.round(r.w); c.height = Math.round(r.h);
      c.getContext('2d').drawImage(video, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
      cam.classList.add('flash');
      go(c.toDataURL('image/jpeg', 0.92));
    });
    const onFile = (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const r = new FileReader();
      r.onload = async () => go(r.result, { hashSource: await f.arrayBuffer() }); // 같은 파일 판단은 원본 바이트로
      r.readAsDataURL(f);
    };
    document.getElementById('fileInput').addEventListener('change', onFile);
    document.getElementById('nativeInput').addEventListener('change', onFile);

    const sheet = document.getElementById('sampleSheet');
    document.getElementById('sampleBtn').addEventListener('click', () => { sheet.hidden = false; });
    // 샘플: 촬영할 수 있는 문서의 예시 이미지만 보여 준다 (등록·인식하지 않음)
    const SAMPLES = {
      invoice: ['거래명세서 샘플', '/samples/invoice.jpg'],
      giro: ['지로 고지서 샘플', '/samples/giro.webp'],
    };
    const view = document.getElementById('sampleView');
    const viewImg = document.getElementById('sampleImg');
    sheet.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      sheet.hidden = true;
      const s = SAMPLES[b.dataset.sample];
      if (!s) return;
      document.getElementById('sampleTitle').textContent = s[0];
      viewImg.src = s[1];
      viewImg.alt = s[0];
      view.classList.remove('zoomed');
      view.hidden = false;
      paused = true; // 보는 동안 문서 감지 멈춤
    }));
    viewImg.addEventListener('dblclick', () => view.classList.toggle('zoomed'));
    document.getElementById('sampleClose').addEventListener('click', () => {
      view.hidden = true;
      paused = false;
    });
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    clearInterval(camTimer);
    if (onCamResize) window.removeEventListener('resize', onCamResize);
    onCamResize = null;
    document.body.classList.remove('dark');
  }

  async function capture(dataUrl, docType, retakeId, fileHash) {
    const imageUrl = await OCR.downscale(dataUrl);
    let doc;
    if (retakeId) {
      doc = await DB.setStatus(retakeId, 'processing', { imageUrl, fileHash, ...(docType !== 'auto' ? { documentType: docType } : {}) });
    } else {
      // 같은 파일이 이미 있으면 등록 전에 알린다 (내용 비교는 인식이 끝난 뒤 한 번 더)
      let duplicateOf = null;
      const dups = fileHash ? await DB.checkFileDuplicates(fileHash).catch(() => []) : [];
      if (dups.length) {
        const c = await duplicateDialog(dups, { stage: 'upload' });
        if (c.decision === 'cancel') return;
        duplicateOf = c.duplicateOf;
      }
      doc = await DB.createDocument({ documentType: docType, imageUrl, fileHash, duplicateOf });
    }
    location.hash = `#/process/${doc.id}`;
  }

  // ---------- 인식 처리 ----------
  async function renderProcess(id) {
    const { doc } = await DB.documentBundle(id);
    const steps = ['촬영 품질 검사', '텍스트 인식 (OCR)', '정보 추출', '데이터 대조', '중복 문서 확인'];
    h(`
      <div class="process">
        <div class="scan"><img src="${doc.imageUrl}" alt=""><div class="beam"></div></div>
        <ol class="steps">${steps.map((s, i) => `<li data-i="${i}"><span class="dot"></span>${s}<em></em></li>`).join('')}</ol>
        <div class="bar"><div id="bar"></div></div>
        <p class="muted" id="procMsg">처음 실행 시 한국어 인식 모델(약 16MB)을 내려받습니다.</p>
      </div>
    `);
    const step = (i, state, note = '') => {
      const li = $view.querySelector(`.steps li[data-i="${i}"]`);
      if (!li) return;
      li.className = state;
      li.querySelector('em').textContent = note;
    };
    const bar = (p) => { const b = document.getElementById('bar'); if (b) b.style.width = `${Math.round(p * 100)}%`; };

    try {
      step(0, 'active');
      const q = await OCR.quality(doc.imageUrl);
      step(0, q.issues.length ? 'warn' : 'done', q.issues.join(', '));
      bar(0.1);

      step(1, 'active');
      const ocr = await OCR.recognize(doc.imageUrl, (m) => {
        if (m.status === '글자 인식 중') bar(0.15 + m.progress * 0.7);
        const msg = document.getElementById('procMsg');
        if (msg && m.status) msg.textContent = `${m.status}${m.progress ? ` ${Math.round(m.progress * 100)}%` : ''}`;
      });
      step(1, 'done', `${Math.round(ocr.confidence)}%`);
      // 옆으로·거꾸로 찍힌 사진은 바로 세워서 다시 저장
      if (ocr.rotation) await DB.setStatus(id, 'processing', { imageUrl: await OCR.rotateDataUrl(doc.imageUrl, ocr.rotation) });

      step(2, 'active');
      const typeHint = doc.documentType;
      const memory = await DB.memory().catch(() => ({})); // 이전에 검수 확정한 상호·고객명
      const parsed = Parser.parse(ocr, typeHint, memory);
      if (q.issues.length) parsed.data.qualityIssues = q.issues;
      await DB.saveExtraction(id, parsed.data, parsed.lineItems);
      // 최초 OCR 결과(글자 상자 포함)와 최초 추출값을 남겨 둔다 → 검수 확정값과 짝지어 학습 데이터가 된다
      await DB.saveOcrResult(id, {
        engine: OCR.ENGINE, modelVersion: OCR.MODEL_VERSION, result: OCR.toStored(ocr),
        parsed: { documentType: parsed.documentType, data: parsed.data, lineItems: parsed.lineItems, fieldBoxes: parsed.fieldBoxes },
      }).catch((e) => console.warn('OCR 결과 저장 실패', e));
      step(2, 'done', `${parsed.lineItems.length}개 품목`);
      bar(0.92);

      step(3, 'active');
      const checks = Parser.validate(parsed.data, parsed.lineItems, parsed.documentType);
      const errors = checks.filter((c) => c.level === 'error').length;
      const warns = checks.filter((c) => c.level === 'warn').length;
      step(3, errors ? 'warn' : 'done', errors || warns ? `오류 ${errors} · 주의 ${warns}` : '모두 일치');
      bar(0.96);

      // 등록 전 중복 확인: 업로드 단계에서 이미 "중복으로 등록"을 고른 문서는 건너뛴다
      step(4, 'active');
      if (doc.duplicateDecision) step(4, 'warn', '중복으로 등록됨');
      else {
        const dups = await DB.documentDuplicates(id);
        if (!dups.length) step(4, 'done', '없음');
        else {
          step(4, 'warn', dups.some((d) => d.level === 'exact') ? '정확히 일치' : '중복 가능성');
          const c = await duplicateDialog(dups, { stage: 'process' });
          if (c.decision === 'cancel') {
            await DB.deleteDocument(id);
            await refreshBadge();
            toast('등록을 취소했습니다');
            location.hash = '#/';
            return;
          }
          await DB.setDuplicate(id, c.decision, c.duplicateOf);
          step(4, 'done', c.decision === 'duplicate' ? '중복으로 등록 (재고 미반영)' : '별개 문서로 등록');
        }
      }
      bar(1);

      const retakeReason = Parser.needsRetake(parsed.data);
      let status = 'needs_review';
      const patch = { documentType: parsed.documentType, retakeReason: retakeReason || null };
      if (retakeReason) status = 'needs_retake';
      else if (!errors && !warns && parsed.data.confidenceScore >= AUTO_VERIFY_SCORE) {
        status = 'verified';
        patch.verifiedBy = 'auto';
      }
      await DB.setStatus(id, status, patch);
      await refreshBadge();
      setTimeout(() => {
        if (status === 'needs_retake') location.hash = `#/retake/${id}`;
        else {
          if (status === 'verified') toast('모든 항목이 일치해 자동 저장되었습니다');
          location.hash = `#/review/${id}`;
        }
      }, 600);
    } catch (e) {
      console.error(e);
      await DB.setStatus(id, 'needs_retake', { retakeReason: '인식 중 오류가 발생했습니다: ' + e.message });
      location.hash = `#/retake/${id}`;
    }
  }

  // ---------- 재촬영 안내 ----------
  async function renderRetake(id) {
    const b = await DB.documentBundle(id);
    if (!b) return (location.hash = '#/');
    const issues = b.ex?.qualityIssues || [];
    h(`
      <header class="top"><a href="#/" class="back">‹</a><h1>재촬영 필요</h1></header>
      <div class="retake">
        <img src="${b.doc.imageUrl}" alt="">
        <div class="alert error">
          <b>${esc(b.doc.retakeReason || '인식 결과가 충분하지 않습니다.')}</b>
          ${issues.length ? `<p>사진 상태: ${esc(issues.join(', '))}</p>` : ''}
        </div>
        <ul class="tips">
          <li>밝은 곳에서 그림자 없이 촬영하세요</li>
          <li>문서를 평평하게 펴고 정면에서 찍으세요</li>
          <li>네 모서리가 화면 안에 모두 들어오게 하세요</li>
          <li>초점이 맞을 때까지 잠시 멈춘 뒤 촬영하세요</li>
        </ul>
        <div class="actions">
          <a class="btn primary" href="#/camera?retake=${id}">다시 촬영</a>
          <a class="btn ghost" href="#/review/${id}?force=1">그대로 직접 입력</a>
          <button class="btn text danger" id="delBtn">문서 삭제</button>
        </div>
      </div>
    `);
    document.getElementById('delBtn').addEventListener('click', async () => {
      if (await confirmDelete(id, b)) location.hash = '#/';
    });
  }

  // ---------- 검수 ----------
  async function renderReview(id) {
    const b = await DB.documentBundle(id);
    if (!b) return (location.hash = '#/');
    const { doc, logs } = b;
    const ex = b.ex || { fieldConfidence: {}, confidenceScore: 0, rawText: '' };
    let items = b.items.map((it) => ({ ...it }));
    const fc = ex.fieldConfidence || {};
    const checks = Parser.validate(ex, items, doc.documentType);
    const byField = {};
    checks.forEach((c) => { (byField[c.field] = byField[c.field] || []).push(c); });
    const scorePct = Math.round((ex.confidenceScore || 0) * 100);

    const confDot = (f) => {
      if (ex[f] == null || ex[f] === '') return '<i class="cd none" title="미인식"></i>';
      const c = fc[f] ?? 0;
      const cls = c >= 0.8 ? 'hi' : c >= 0.6 ? 'mid' : 'lo';
      return `<i class="cd ${cls}" title="신뢰도 ${Math.round(c * 100)}%"></i>`;
    };
    const fieldInput = ([key, label, kind]) => {
      const v = ex[key];
      const val = kind === 'money' ? fmt(v) : v ?? '';
      const st = (byField[key] || []).find((c) => c.level !== 'ok');
      return `
        <label class="field ${st ? st.level : ''} ${v == null || v === '' ? 'empty' : ''}">
          <span class="lbl">${confDot(key)}${label}</span>
          <input name="${key}" data-kind="${kind}" value="${esc(val)}"
            ${kind === 'date' ? 'type="date"' : kind === 'month' ? 'type="month"' : kind === 'money' ? 'inputmode="numeric"' : key === 'businessNumber' ? 'inputmode="numeric" placeholder="000-00-00000"' : ''}>
          ${st ? `<small>${esc(st.message)}</small>` : ''}
        </label>`;
    };

    // 재고 반영 상태 (거래명세서·세금계산서만)
    const invCard = () => {
      if (!INVENTORY_TYPES.includes(doc.documentType)) return '';
      const inv = b.inventory || [];
      let body;
      if (doc.inventoryStatus === 'applied') {
        body = `<p class="muted">검수 완료된 품목이 재고에 반영되었습니다. 품목명·수량을 고쳐 저장하면 재고도 함께 바뀝니다.</p>
          <ul class="inv-moves">${inv.map((m) => `<li><a href="#/inventory/${m.itemId}">${esc(m.name)}</a><b>+${qtyLabel(m.quantity)}${esc(m.unit || '')}</b></li>`).join('')}</ul>`;
      } else if (doc.inventoryStatus === 'skipped_duplicate') {
        body = '<p class="muted">중복 문서로 등록되어 재고에 반영하지 않았습니다.</p>';
      } else if (doc.status === 'verified') {
        body = '<p class="muted">반영할 품목이 없습니다. 품목명과 수량이 있는 줄만 재고에 들어갑니다.</p>';
      } else {
        body = '<p class="muted">검수 완료하면 품목명·수량이 있는 품목이 재고에 반영됩니다.</p>';
      }
      return `<section class="card"><div class="card-h"><h2>재고 반영</h2></div>${body}</section>`;
    };
    const dupCard = () => (doc.duplicateDecision !== 'duplicate' ? '' : `
      <section class="card dup-card">
        <div class="card-h"><h2>중복 등록 문서</h2></div>
        ${b.duplicateOfDoc ? `<p>원본: <a href="#/review/${b.duplicateOfDoc.id}"><b>${esc(b.duplicateOfDoc.vendorName || '상호 미확인')}</b>
          · ${b.duplicateOfDoc.issueDate || ''} · ${b.duplicateOfDoc.totalAmount != null ? fmt(b.duplicateOfDoc.totalAmount) + '원' : ''}</a></p>` : ''}
        <p class="muted">이 문서는 재고에 반영되지 않습니다.</p>
        <button class="btn ghost block" id="notDupBtn">중복 아님 — 별개 문서로 재고에 반영</button>
      </section>`);

    h(`
      <header class="top"><a href="#/" class="back">‹</a><h1>검수</h1>${badge(doc.status)}
        <button class="del-btn" id="delDoc" aria-label="문서 삭제">삭제</button></header>
      <div class="review">
        <div class="doc-img" id="docImg"><img src="${doc.imageUrl}" alt="촬영 문서"><span>탭하여 확대</span></div>

        <div class="score">
          <div class="ring" style="--p:${scorePct}"><b>${scorePct}</b><small>%</small></div>
          <div>
            <b>인식 신뢰도</b>
            <p class="muted">${doc.verifiedBy === 'auto' ? '모든 대조 항목이 일치해 자동 저장됨' :
              scorePct >= 85 ? '대부분 정확합니다. 표시된 항목만 확인하세요.' :
              scorePct >= 60 ? '노란색·빨간색 항목을 원본과 비교해 주세요.' : '인식이 불완전합니다. 재촬영을 권장합니다.'}</p>
          </div>
        </div>

        <section class="card">
          <div class="card-h"><h2>문서 종류</h2></div>
          <select name="documentType" id="docType">${Object.entries(Parser.DOC_TYPES).filter(([k]) => k !== 'auto')
            .map(([k, v]) => `<option value="${k}" ${k === doc.documentType ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </section>
        ${dupCard()}

        <section class="card">
          <div class="card-h"><h2>추출 정보</h2></div>
          <form id="fieldsForm">${FIELDS.map(fieldInput).join('')}</form>
        </section>

        <section class="card">
          <div class="card-h"><h2>거래 상세 항목</h2><button class="ghost sm" id="addItem">+ 추가</button></div>
          <div id="items"></div>
        </section>
        ${invCard()}

        <section class="card">
          <div class="card-h"><h2>데이터 대조</h2></div>
          <ul class="checks" id="checks"></ul>
        </section>

        <details class="card">
          <summary>인식된 원문 보기</summary>
          <pre>${esc(ex.rawText || '(없음)')}</pre>
        </details>

        ${logs.length ? `
        <details class="card">
          <summary>검수 기록 (${logs.length})</summary>
          <ul class="logs">${logs.map((l) => `
            <li><b>${esc(fieldLabel(l.fieldName))}</b>
              <span><s>${esc(l.originalValue) || '(빈 값)'}</s> → ${esc(l.correctedValue) || '(빈 값)'}</span>
              <small>${dateLabel(l.reviewedAt)}</small></li>`).join('')}</ul>
        </details>` : ''}

        <div class="sticky-actions">
          <a class="btn ghost" href="#/camera?retake=${id}">재촬영</a>
          <button class="btn primary" id="saveBtn">${doc.status === 'verified' ? '수정 저장' : '검수 완료'}</button>
        </div>
      </div>
      <div class="zoom" id="zoom" hidden><img src="${doc.imageUrl}" alt=""></div>
    `);

    // 품목 표
    const $items = document.getElementById('items');
    function drawItems() {
      $items.innerHTML = items.length ? items.map((it, i) => {
        const bad = itemMismatch(it);
        return `
        <div class="item ${bad ? 'bad' : ''}" data-i="${i}">
          <div class="name-row">
            <input class="name" data-k="itemName" value="${esc(it.itemName)}" placeholder="품목명">
            <input class="unit" data-k="unit" value="${esc(it.unit)}" placeholder="단위" aria-label="단위">
          </div>
          <div class="nums">
            <input data-k="quantity" inputmode="decimal" value="${esc(it.quantity)}" placeholder="수량">
            <span>×</span>
            <input data-k="unitPrice" inputmode="numeric" value="${esc(fmt(it.unitPrice))}" placeholder="단가">
            <span>=</span>
            <input data-k="amount" inputmode="numeric" value="${esc(fmt(it.amount))}" placeholder="금액">
            <button class="x" data-del="${i}" aria-label="삭제">✕</button>
          </div>
        </div>`;
      }).join('') : '<p class="muted">인식된 품목이 없습니다.</p>';
    }
    drawItems();
    $items.addEventListener('input', (e) => {
      const row = e.target.closest('.item');
      if (!row) return;
      const it = items[row.dataset.i];
      const k = e.target.dataset.k;
      // 수량은 소수(1.5kg 등)를 허용하고, 금액은 정수로
      it[k] = k === 'itemName' || k === 'unit' ? e.target.value
        : k === 'quantity' ? toQty(e.target.value) : Parser.toNumber(e.target.value);
      if (k === 'quantity' || k === 'unitPrice') {
        if (it.quantity && it.unitPrice) {
          it.amount = it.quantity * it.unitPrice;
          row.querySelector('[data-k="amount"]').value = fmt(it.amount);
        }
      }
      row.classList.toggle('bad', itemMismatch(it));
      drawChecks();
    });
    $items.addEventListener('click', (e) => {
      const d = e.target.dataset.del;
      if (d == null) return;
      items.splice(+d, 1);
      drawItems(); drawChecks();
    });
    document.getElementById('addItem').addEventListener('click', () => {
      items.push({ itemName: '', unit: '', quantity: 1, unitPrice: null, amount: null });
      drawItems();
      $items.querySelector('.item:last-child .name').focus();
    });

    // 입력 중 실시간 재대조
    const form = document.getElementById('fieldsForm');
    function current() {
      const out = {};
      form.querySelectorAll('input').forEach((inp) => {
        const k = inp.dataset.kind;
        let v = inp.value.trim();
        out[inp.name] = v === '' ? null : k === 'money' ? Parser.toNumber(v) : v;
      });
      return out;
    }
    function drawChecks() {
      const cur = { ...ex, ...current() };
      const list = Parser.validate(cur, items, document.getElementById('docType').value);
      document.getElementById('checks').innerHTML = list.length
        ? list.map((c) => `<li class="${c.level}"><i></i>${esc(c.message)}</li>`).join('')
        : '<li class="muted">대조할 항목이 없습니다.</li>';
    }
    drawChecks();
    form.addEventListener('input', (e) => {
      const inp = e.target;
      if (inp.dataset.kind === 'money') {
        const n = Parser.toNumber(inp.value);
        inp.value = n == null ? '' : fmt(n);
      }
      if (inp.name === 'businessNumber') {
        const d = inp.value.replace(/\D/g, '').slice(0, 10);
        inp.value = d.length > 5 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d;
      }
      inp.closest('.field').classList.remove('error', 'warn', 'empty');
      drawChecks();
    });
    document.getElementById('docType').addEventListener('change', drawChecks);

    // 원본 확대
    const zoom = document.getElementById('zoom');
    document.getElementById('docImg').addEventListener('click', () => { zoom.hidden = false; });
    zoom.addEventListener('click', () => { zoom.hidden = true; });

    // 삭제: 확인 창 → 이미지·추출·OCR 결과·학습 데이터 삭제, 재고 반영분 되돌림
    document.getElementById('delDoc').addEventListener('click', async () => {
      if (await confirmDelete(id, b)) location.hash = '#/';
    });
    document.getElementById('notDupBtn')?.addEventListener('click', async () => {
      await DB.setDuplicate(id, 'distinct');
      toast('별개 문서로 바꿨습니다');
      renderReview(id);
    });

    // 저장: 바뀐 필드마다 ReviewLog를 남긴다
    const saveBtn = document.getElementById('saveBtn');
    saveBtn.addEventListener('click', async () => {
      const cur = current();
      const newType = document.getElementById('docType').value;
      const errors = Parser.validate({ ...ex, ...cur }, items, newType).filter((c) => c.level === 'error');
      if (errors.length && !confirm(`대조 오류가 ${errors.length}건 있습니다. 그래도 저장할까요?\n\n- ${errors.map((e) => e.message).join('\n- ')}`)) return;

      const changes = [];
      for (const [key] of FIELDS) {
        const before = ex[key] ?? null;
        const after = cur[key] ?? null;
        if (String(before ?? '') !== String(after ?? '')) changes.push([key, before, after]);
      }
      if (newType !== doc.documentType) changes.push(['documentType', doc.documentType, newType]);
      const itemsKey = (arr) => JSON.stringify(arr.map((i) => [i.itemName, i.unit || '', +i.quantity || 0, +i.unitPrice || 0, +i.amount || 0]));
      if (itemsKey(items) !== itemsKey(b.items)) changes.push(['lineItems', `${b.items.length}개 품목`, `${items.length}개 품목`]);

      saveBtn.disabled = true;
      try {
        const { id: _exId, documentId: _d, ...exRest } = ex;
        const cleanItems = items.filter((i) => i.itemName || i.amount)
          .map(({ itemName, unit, quantity, unitPrice, amount }) => ({ itemName, unit, quantity, unitPrice, amount }));
        await DB.saveExtraction(id, { ...exRest, ...cur }, cleanItems);

        // 고친 정보로 중복을 한 번 더 확인 (아직 중복 판단을 내리지 않은 문서만)
        if (!doc.duplicateDecision) {
          const dups = await DB.documentDuplicates(id);
          if (dups.length) {
            const c = await duplicateDialog(dups, { stage: 'review' });
            if (c.decision === 'cancel') return;
            await DB.setDuplicate(id, c.decision, c.duplicateOf);
          }
        }

        for (const [fieldName, o, c] of changes) {
          await DB.logReview({ documentId: id, reviewerId: user.id, fieldName, originalValue: o, correctedValue: c });
        }
        // 검수 완료 → 서버가 재고 반영과 학습 데이터(이미지·최초 OCR·확정값) 저장을 함께 처리한다
        const saved = await DB.setStatus(id, 'verified', { documentType: newType, verifiedBy: user.id, verifiedAt: new Date().toISOString() });
        await refreshBadge();
        const invNote = saved.inventoryStatus === 'applied' ? ' · 재고 반영' : saved.inventoryStatus === 'skipped_duplicate' ? ' · 중복이라 재고 미반영' : '';
        toast((changes.length ? `${changes.length}개 항목을 수정해 저장했습니다` : '검수 완료로 저장했습니다') + invNote);
        location.hash = '#/';
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  function toQty(s) {
    const n = parseFloat(String(s ?? '').replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  // ---------- 재고 ----------
  async function renderInventory() {
    const list = await DB.inventory();
    h(`
      <header class="top"><h1>재고<small class="wp">${esc(wpLabel(user.workplace))}</small></h1></header>
      <div class="review">
        <p class="muted inv-note">검수 완료된 거래명세서·세금계산서의 품목이 입고로 쌓입니다. 이름이 같은 품목(공백·대소문자 무시)은 하나로 합쳐집니다.</p>
        ${list.length ? `<input class="search" id="invSearch" placeholder="품목 검색" type="search">` : ''}
        <ul class="inv-list" id="invList">${list.map((it) => `
          <li data-name="${esc(it.name.toLowerCase())}"><a href="#/inventory/${it.id}">
            <div><b>${esc(it.name)}</b><small>입고 ${it.movements}건${it.lastInAt ? ` · 최근 ${dateLabel(it.lastInAt)}` : ''}</small></div>
            <span class="qty">${qtyLabel(it.quantity)}<em>${esc(it.unit || '')}</em></span>
          </a></li>`).join('')}</ul>
        ${list.length ? '' : `<div class="empty"><div class="empty-ico">📦</div><p>아직 재고 품목이 없습니다.<br>거래명세서를 촬영해 검수 완료하면 자동으로 쌓입니다.</p></div>`}
      </div>
    `);
    document.getElementById('invSearch')?.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      document.querySelectorAll('#invList li').forEach((li) => { li.hidden = q && !li.dataset.name.includes(q); });
    });
  }

  async function renderInventoryItem(itemId) {
    const { item, movements } = await DB.inventoryItem(itemId);
    h(`
      <header class="top"><a href="#/inventory" class="back">‹</a><h1>${esc(item.name)}</h1></header>
      <div class="review">
        <section class="card inv-head"><span>현재 재고</span><b>${qtyLabel(item.quantity)}<em>${esc(item.unit || '')}</em></b></section>
        <section class="card">
          <div class="card-h"><h2>입고 내역</h2></div>
          <ul class="inv-moves">${movements.map((m) => `
            <li>${m.documentId ? `<a href="#/review/${m.documentId}">` : '<span>'}
              <span><b>${esc(m.vendorName || '상호 미확인')}</b>
                <small>${m.issueDate || dateLabel(m.createdAt)}${m.documentNumber ? ` · ${esc(m.documentNumber)}` : ''} · ${esc(m.itemName)}</small></span>
              <b class="plus">+${qtyLabel(m.quantity)}${esc(item.unit || '')}</b>
            ${m.documentId ? '</a>' : '</span>'}</li>`).join('')}</ul>
        </section>
      </div>
    `);
  }

  function fieldLabel(f) {
    const hit = FIELDS.find(([k]) => k === f);
    return hit ? hit[1] : { documentType: '문서 종류', lineItems: '거래 상세 항목' }[f] || f;
  }

  // ---------- 앱 설치 (PWA) ----------
  let installPrompt = null; // 안드로이드 크롬의 beforeinstallprompt 이벤트
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    if (!location.hash || location.hash === '#/' || location.hash.startsWith('#/me')) route();
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; toast('홈 화면에 설치되었습니다'); });
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function installState() {
    if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) return 'installed';
    if (installPrompt) return 'prompt';
    if (isIOS()) return 'ios';
    return 'unsupported';
  }

  // ---------- 로그인 / 가입 ----------
  async function renderLogin(params) {
    const mode = params.get('mode') === 'signup' ? 'signup' : 'login';
    const signupFields = `
      <label class="field"><span class="lbl">업장코드</span>
        <input name="workplaceCode" autocomplete="off" placeholder="예: HS-001" maxlength="30" required>
        <small id="codeMsg" class="code-msg">업장코드를 입력하세요. 나중에 내 정보에서 바꿀 수 있습니다</small></label>
      <label class="field"><span class="lbl">업장명</span><input name="name" autocomplete="organization" required></label>
      <div class="field">
        <span class="lbl">휴대폰 번호</span>
        <div class="with-btn">
          <input name="phone" type="tel" inputmode="numeric" autocomplete="tel" placeholder="010-0000-0000" maxlength="13" required>
          <button type="button" class="btn ghost" id="sendCode">인증번호 받기</button>
        </div>
      </div>
      <div class="field" id="otpField" hidden>
        <span class="lbl">인증번호</span>
        <div class="with-btn">
          <input name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6자리">
          <button type="button" class="btn ghost" id="verifyCode">확인</button>
        </div>
        <small id="phoneMsg" class="code-msg"></small>
      </div>`;
    h(`
      <div class="auth">
        <img class="auth-logo" src="/icons/icon-192.png" alt="">
        <h1>찰칵장부</h1>
        <p class="muted">고지서·명세서를 찍으면 자동으로 장부에 들어갑니다</p>
        <div class="seg">
          <a href="#/login" class="${mode === 'login' ? 'on' : ''}">로그인</a>
          <a href="#/login?mode=signup" class="${mode === 'signup' ? 'on' : ''}">회원가입</a>
        </div>
        <form id="authForm" class="auth-form">
          ${mode === 'signup' ? signupFields : ''}
          <label class="field"><span class="lbl">이메일</span><input name="email" type="email" autocomplete="email" inputmode="email" required></label>
          <label class="field"><span class="lbl">비밀번호${mode === 'signup' ? ' (8자 이상)' : ''}</span>
            <input name="password" type="password" minlength="${mode === 'signup' ? 8 : 1}" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" required></label>
          ${mode === 'signup' ? `
          <div class="consent">
            <label class="check"><input type="checkbox" name="agreePrivacy"> <span><b>[필수]</b> 개인정보 수집·이용, 처리 위탁 및 국외 이전에 동의합니다</span></label>
            <details><summary>내용 보기</summary>${Policy.privacyConsent}</details>
            <a href="#/privacy" class="policy-link">개인정보 처리방침</a>
          </div>` : '<a href="#/privacy" class="policy-link">개인정보 처리방침</a>'}
          <p class="form-err" id="authErr" hidden></p>
          <button class="btn primary" type="submit" id="authSubmit">${mode === 'signup' ? '가입하고 시작하기' : '로그인'}</button>
        </form>
      </div>
    `);
    let phoneToken = null; // 문자 인증 성공 시 받은 가입용 토큰
    let verifiedPhone = null;
    if (mode === 'signup') {
      const form = document.getElementById('authForm');
      const msg = document.getElementById('codeMsg');

      // ---- 휴대폰 문자 인증 ----
      const digitsOf = (s) => s.replace(/\D/g, '');
      const phoneMsg = document.getElementById('phoneMsg');
      const sendBtn = document.getElementById('sendCode');
      const setPhoneMsg = (text, cls = '') => { phoneMsg.textContent = text; phoneMsg.className = `code-msg ${cls}`; };
      let timer = null;
      form.phone.addEventListener('input', () => {
        const d = digitsOf(form.phone.value).slice(0, 11);
        form.phone.value = d.length > 7 ? `${d.slice(0, 3)}-${d.slice(3, d.length - 4)}-${d.slice(-4)}` : d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d;
        if (verifiedPhone && digitsOf(form.phone.value) !== verifiedPhone) { // 번호를 바꾸면 다시 인증
          phoneToken = null; verifiedPhone = null;
          form.otp.disabled = false; document.getElementById('verifyCode').disabled = false;
          setPhoneMsg('번호가 바뀌어 다시 인증해야 합니다', 'bad');
        }
      });
      sendBtn.addEventListener('click', async () => {
        const phone = digitsOf(form.phone.value);
        document.getElementById('otpField').hidden = false;
        if (!/^01[016789]\d{7,8}$/.test(phone)) return setPhoneMsg('휴대폰 번호를 정확히 입력하세요', 'bad');
        sendBtn.disabled = true;
        try {
          const r = await DB.sendPhoneCode(phone);
          let left = r.expiresIn;
          clearInterval(timer);
          const tick = () => {
            if (phoneToken) return clearInterval(timer);
            if (left <= 0) { clearInterval(timer); return setPhoneMsg('인증번호가 만료되었습니다. 다시 받아 주세요', 'bad'); }
            setPhoneMsg(`문자로 받은 인증번호를 입력하세요 (${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')})${r.devCode ? ` · 개발용 번호 ${r.devCode}` : ''}`);
            left--;
          };
          tick();
          timer = setInterval(tick, 1000);
          sendBtn.textContent = '다시 받기';
          form.otp.focus();
          setTimeout(() => { sendBtn.disabled = false; }, 60_000); // 서버 제한과 같은 1분
        } catch (ex) {
          setPhoneMsg(ex.message, 'bad');
          sendBtn.disabled = false;
        }
      });
      document.getElementById('verifyCode').addEventListener('click', async () => {
        const phone = digitsOf(form.phone.value);
        try {
          const r = await DB.verifyPhoneCode(phone, form.otp.value.trim());
          phoneToken = r.verificationToken;
          verifiedPhone = phone;
          clearInterval(timer);
          form.otp.disabled = true;
          document.getElementById('verifyCode').disabled = true;
          setPhoneMsg('✓ 휴대폰 인증이 완료되었습니다', 'ok');
        } catch (ex) {
          setPhoneMsg(ex.message, 'bad');
        }
      });

      // 업장코드를 입력하면 새 업장인지, 이미 있는 업장(→ 관리자 승인 후 이용)인지 알려 준다
      let lastCode = '';
      const check = async () => {
        const raw = form.workplaceCode.value.trim();
        const norm = raw.replace(/\s/g, '').toUpperCase();
        if (!norm || norm === lastCode) return;
        lastCode = norm;
        try {
          const r = await DB.checkWorkplace(raw);
          msg.textContent = r.exists
            ? '이미 등록된 업장코드입니다. 가입하면 그 업장 관리자가 승인한 뒤 이용할 수 있습니다'
            : '새 업장코드입니다. 가입하면 이 업장의 관리자가 되며, 운영자가 개설을 확인한 뒤 이용할 수 있습니다';
          msg.className = `code-msg ${r.exists ? '' : 'ok'}`;
        } catch (e) {
          msg.textContent = e.message;
          msg.className = 'code-msg bad';
        }
      };
      form.workplaceCode.addEventListener('change', check);
      form.workplaceCode.addEventListener('blur', check);
    }
    document.getElementById('authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const btn = document.getElementById('authSubmit');
      const err = document.getElementById('authErr');
      if (mode === 'signup' && !phoneToken) {
        err.textContent = '휴대폰 문자 인증을 먼저 완료하세요';
        err.hidden = false;
        return;
      }
      if (mode === 'signup' && !f.agreePrivacy) {
        err.textContent = '개인정보 수집·이용에 동의해야 가입할 수 있습니다';
        err.hidden = false;
        return;
      }
      btn.disabled = true;
      err.hidden = true;
      try {
        user = mode === 'signup'
          ? await DB.signup({ email: f.email, password: f.password, name: f.name, workplaceCode: f.workplaceCode, phone: verifiedPhone, phoneToken, consents: { privacy: Policy.PRIVACY_VERSION } })
          : await DB.login(f.email, f.password);
        if (user.privacyConsentRequired) return (location.hash = '#/consent');
        if (user.status === 'pending') return (location.hash = '#/pending');
        await refreshBadge();
        location.hash = '#/';
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        btn.disabled = false;
      }
    });
  }

  // ---------- 내 정보 ----------
  const fmtPhone = (p) => String(p || '').replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');

  async function renderMe() {
    const st = installState();
    const isAdmin = user.role === 'admin';
    const wp = await DB.workplace();
    const active = wp.members.filter((m) => m.status !== 'pending');
    const pending = wp.members.filter((m) => m.status === 'pending');
    const newWorkplaces = user.isOperator ? await DB.pendingWorkplaces().catch(() => []) : [];
    h(`
      <header class="top"><a href="#/" class="back">‹</a><h1>내 정보</h1></header>
      <div class="review">
        <section class="card profile">
          <span class="avatar lg">${esc((user.name || '?').slice(0, 1))}</span>
          <div><b>${esc(user.name)}</b><p class="muted">${esc(user.email)}${user.phone ? ` · ${esc(fmtPhone(user.phone))}` : ''}</p></div>
        </section>

        <section class="card">
          <div class="card-h"><h2>소속 업장</h2><span class="badge ${isAdmin ? 'st-ok' : 'st-proc'}">${isAdmin ? '관리자' : '구성원'}</span></div>
          <p class="wp-name"><b>${esc(user.workplace.code || user.workplace.hotelName)}</b> · ${esc(user.workplace.name)}</p>
          ${user.workplace.code ? '' : '<p class="muted"><b>업장코드가 아직 없습니다.</b> 관리자가 아래 "업장 정보 수정"에서 정해 주세요. 그래야 같은 업장 사람들이 업장코드로 가입할 수 있습니다.</p>'}
          <p class="muted">같은 업장 구성원끼리만 문서·재고를 함께 봅니다. 다른 업장의 데이터는 보이지 않습니다.</p>
          <details class="members"><summary>구성원 ${active.length}명</summary>
            <ul>${active.map((m) => `<li class="member"><span>${esc(m.name)} <small>${esc(m.email)}${m.role === 'admin' ? ' · 관리자' : ''}</small></span>
              ${isAdmin && m.id !== user.id ? `<button class="ghost sm" data-role="${m.role === 'admin' ? 'member' : 'admin'}" data-member="${m.id}">${m.role === 'admin' ? '관리자 해제' : '관리자 지정'}</button>` : ''}</li>`).join('')}</ul>
          </details>
          ${isAdmin ? `
          <details class="members"><summary>업장 정보 수정</summary>
            <form id="wpForm" class="wp-form">
              <label class="field"><span class="lbl">업장코드</span><input name="code" value="${esc(user.workplace.code || '')}" maxlength="30" placeholder="예: HS-001" required></label>
              <label class="field"><span class="lbl">업장명</span><input name="name" value="${esc(user.workplace.name)}" required></label>
              <button class="btn ghost block">저장</button>
            </form>
          </details>` : ''}
        </section>

        ${isAdmin ? `
        <section class="card">
          <div class="card-h"><h2>가입 승인</h2>${pending.length ? `<span class="badge st-review">대기 ${pending.length}명</span>` : ''}</div>
          <p class="muted">업장코드 <b>${esc(user.workplace.code || '(미정)')}</b>로 가입한 사람은 승인해야 문서·재고를 볼 수 있습니다. 모르는 사람은 거절하세요.</p>
          <ul class="pending-list">${pending.map((m) => `
            <li><span><b>${esc(m.name)}</b><small>${esc(m.email)}${m.phone ? ` · ${esc(fmtPhone(m.phone))}` : ''} · ${dateLabel(m.createdAt)} 가입</small></span>
              <button class="ghost sm" data-approve="${m.id}">승인</button>
              <button class="ghost sm danger-text" data-reject="${m.id}" data-name="${esc(m.name)}">거절</button></li>`).join('')
            || '<li class="muted">승인을 기다리는 사람이 없습니다.</li>'}</ul>
        </section>

        ${user.isOperator ? `
        <section class="card">
          <div class="card-h"><h2>업장 개설 승인 (운영자)</h2>${newWorkplaces.length ? `<span class="badge st-review">대기 ${newWorkplaces.length}곳</span>` : ''}</div>
          <p class="muted">새 업장코드로 가입하면 여기서 확인해야 열립니다. 실제 지점 담당자가 맞는지(연락처 등) 확인한 뒤 승인하세요.</p>
          <ul class="pending-list">${newWorkplaces.map((w) => `
            <li><span><b>${esc(w.code)} · ${esc(w.name)}</b>
              <small>${dateLabel(w.createdAt)} 신청 · ${w.members.map((m) => `${esc(m.email)}${m.phone ? ` ${esc(fmtPhone(m.phone))}` : ''}${m.role === 'admin' ? '(개설자)' : ''}`).join(', ')}</small></span>
              <button class="ghost sm" data-wp-approve="${w.id}">승인</button>
              <button class="ghost sm danger-text" data-wp-reject="${w.id}" data-code="${esc(w.code)}">거절</button></li>`).join('')
            || '<li class="muted">개설 대기 중인 업장이 없습니다.</li>'}</ul>
        </section>` : ''}

        <section class="card">
          <div class="card-h"><h2>OCR 개선 데이터 활용</h2><span class="badge ${wp.trainingConsent ? 'st-ok' : 'st-proc'}">${wp.trainingConsent ? '동의함' : '동의 안 함'}</span></div>
          ${wp.trainingConsent
            ? `<p class="muted">${new Date(wp.trainingConsent.agreedAt).toLocaleDateString('ko-KR')} ${esc(wp.trainingConsent.byName || '')} 동의.
                검수 완료한 문서를 인식 정확도 개선에 활용합니다.${wp.trainingConsent.current ? '' : ' <b>동의 문구가 바뀌었습니다. 다시 확인해 주세요.</b>'}</p>
              <details><summary>동의 내용</summary>${Policy.trainingConsent}</details>
              ${wp.trainingConsent.current ? '' : '<button class="btn primary block" id="trainAgree">바뀐 내용 확인 후 다시 동의</button>'}
              <button class="btn ghost block" id="trainWithdraw">동의 철회 (모은 데이터 즉시 파기)</button>`
            : `<p class="muted">선택 사항입니다. 동의하면 검수 완료한 문서의 이미지·인식 결과·확정값을 인식 정확도 개선에 씁니다. 동의하지 않아도 모든 기능을 쓸 수 있습니다.</p>
              <details><summary>동의 내용</summary>${Policy.trainingConsent}</details>
              <label class="check"><input type="checkbox" id="trainOwner"> <span>업장 소유주이거나 소유주로부터 동의 권한을 받았습니다</span></label>
              <button class="btn primary block" id="trainAgree">동의</button>`}
        </section>

        <section class="card">
          <div class="card-h"><h2>접속기록</h2></div>
          <p class="muted">로그인, 문서 열람·수정·삭제, 내보내기 등 개인정보 처리 내역을 2년간 보관합니다. 정기적으로 점검해 주세요.</p>
          <details id="logsBox"><summary>최근 기록 보기</summary><ul class="logs-list" id="logsList"><li class="muted">불러오는 중…</li></ul></details>
        </section>` : ''}
        <section class="card">
          <div class="card-h"><h2>홈 화면에 설치</h2></div>
          ${st === 'installed' ? '<p class="muted">앱으로 설치되어 실행 중입니다.</p>'
            : st === 'prompt' ? '<p class="muted">설치하면 앱처럼 전체 화면으로 열리고, 인식 엔진이 저장되어 더 빨리 시작합니다.</p><button class="btn primary block" id="installBtn">앱 설치</button>'
            : st === 'ios' ? `<ol class="ios-steps">
                <li>Safari 아래쪽의 <b>공유</b> 버튼 <span class="share-ico">⬆︎</span> 을 누르세요</li>
                <li><b>홈 화면에 추가</b>를 선택하세요</li>
                <li>오른쪽 위 <b>추가</b>를 누르면 홈 화면에 찰칵장부가 생깁니다</li></ol>
                <p class="muted">아이폰은 Safari에서만 설치할 수 있습니다.</p>`
            : '<p class="muted">이 브라우저는 앱 설치를 지원하지 않습니다. 휴대폰의 Chrome(안드로이드) 또는 Safari(아이폰)에서 열어 주세요.</p>'}
        </section>
        ${isAdmin ? `
        <section class="card">
          <div class="card-h"><h2>데이터</h2></div>
          <button class="btn ghost block" id="exportBtn">전체 데이터 내보내기 (JSON)</button>
        </section>` : ''}
        <section class="card account-links">
          <a href="#/privacy">개인정보 처리방침 ›</a>
          <button class="btn text danger" id="withdrawBtn">회원 탈퇴</button>
        </section>
        <button class="btn text danger" id="logoutBtn">로그아웃</button>
      </div>
    `);
    // ---- 관리자: 권한·학습 데이터 동의·접속기록 ----
    $view.querySelectorAll('[data-member]').forEach((b) => b.addEventListener('click', async () => {
      await DB.setMemberRole(b.dataset.member, b.dataset.role);
      toast(b.dataset.role === 'admin' ? '관리자로 지정했습니다' : '관리자를 해제했습니다');
      renderMe();
    }));
    document.getElementById('trainAgree')?.addEventListener('click', async () => {
      const owner = document.getElementById('trainOwner');
      if (owner && !owner.checked) return toast('소유주 동의 권한을 확인해 주세요');
      await DB.setTrainingConsent(true, Policy.TRAINING_VERSION);
      toast('OCR 개선 데이터 활용에 동의했습니다');
      renderMe();
    });
    document.getElementById('trainWithdraw')?.addEventListener('click', async () => {
      const ok = await dialog({
        title: '동의를 철회할까요?',
        body: '<p>이 업장에서 지금까지 모은 학습 데이터(최초 인식 결과·검수 묶음)를 <b>즉시 파기</b>하고, 앞으로는 모으지 않습니다. 문서·재고 등 다른 데이터는 그대로입니다.</p>',
        actions: [{ label: '취소', value: false }, { label: '철회하고 파기', value: true, cls: 'danger-fill' }],
      });
      if (!ok) return;
      const r = await DB.setTrainingConsent(false);
      toast(`동의를 철회했습니다 · 학습 데이터 ${r.deletedSamples}건 파기`);
      renderMe();
    });
    const ACTION_LABELS = {
      'auth.signup': '가입', 'auth.login': '로그인', 'auth.logout': '로그아웃', 'consent.privacy': '개인정보 동의',
      'account.delete': '회원 탈퇴', 'workplace.view': '업장 정보 열람', 'workplace.update': '업장 정보 수정',
      'consent.training': '학습 데이터 동의 변경', 'member.role': '권한 변경', 'member.update': '가입 승인·권한 변경',
      'member.reject': '가입 거절', 'code.issue': '가입 코드 발급',
      'code.delete': '가입 코드 삭제', 'access_log.view': '접속기록 열람', 'document.create': '문서 등록',
      'document.view': '문서 열람', 'document.update': '문서 상태 변경', 'document.save': '문서 내용 저장',
      'document.delete': '문서 삭제', 'inventory.view': '재고 열람', 'data.export': '전체 데이터 내보내기',
      'training.export': '학습 데이터 내보내기',
    };
    document.getElementById('logsBox')?.addEventListener('toggle', async (e) => {
      if (!e.target.open || e.target.dataset.loaded) return;
      e.target.dataset.loaded = '1';
      const logs = await DB.accessLogs();
      document.getElementById('logsList').innerHTML = logs.map((l) => `
        <li class="${l.result}"><span><b>${esc(ACTION_LABELS[l.action] || l.action)}</b> ${esc(l.userName || '(탈퇴·미확인)')}</span>
          <small>${dateLabel(l.at)} · ${esc(l.ip || '')}${l.result === 'fail' ? ` · 실패(${l.status})` : ''}</small></li>`).join('')
        || '<li class="muted">기록이 없습니다.</li>';
    });
    // ---- 회원 탈퇴 ----
    document.getElementById('withdrawBtn').addEventListener('click', async () => {
      const p = dialog({
        title: '회원 탈퇴',
        body: `<p>계정·로그인 정보·동의 기록이 즉시 삭제되고 되돌릴 수 없습니다. 업장 문서는 업장 자료로 남으며 올린 사람 표시만 지워집니다. 접속기록은 법정 보관 기간(2년) 동안 남습니다.</p>
          <label class="field"><span class="lbl">비밀번호 확인</span><input type="password" id="withdrawPw" autocomplete="current-password"></label>`,
        actions: [{ label: '취소', value: false }, { label: '탈퇴', value: true, cls: 'danger-fill' }],
      });
      const pw = document.getElementById('withdrawPw');
      pw.focus();
      if (!(await p)) return;
      try {
        await DB.deleteAccount(pw.value);
        user = null;
        toast('탈퇴했습니다');
        location.hash = '#/login';
      } catch (ex) {
        toast(ex.message);
      }
    });
    document.getElementById('installBtn')?.addEventListener('click', async () => {
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      renderMe();
    });
    const download = (data, name) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    };
    document.getElementById('exportBtn')?.addEventListener('click', async () => {
      download(await DB.exportAll(), `chalkak-${new Date().toISOString().slice(0, 10)}.json`);
    });

    // ---- 운영자: 업장 개설 승인·거절 ----
    $view.querySelectorAll('[data-wp-approve]').forEach((b) => b.addEventListener('click', async () => {
      await DB.approveWorkplace(b.dataset.wpApprove);
      toast('업장 개설을 승인했습니다');
      renderMe();
    }));
    $view.querySelectorAll('[data-wp-reject]').forEach((b) => b.addEventListener('click', async () => {
      const ok = await dialog({
        title: '업장 개설을 거절할까요?',
        body: `<p><b>${esc(b.dataset.code)}</b> 업장과 그 업장으로 가입한 계정이 삭제됩니다.</p>`,
        actions: [{ label: '취소', value: false }, { label: '거절', value: true, cls: 'danger-fill' }],
      });
      if (!ok) return;
      await DB.rejectWorkplace(b.dataset.wpReject);
      toast('업장 개설을 거절했습니다');
      renderMe();
    }));

    // ---- 관리자: 업장코드·업장명 수정, 가입 승인·거절 ----
    document.getElementById('wpForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        user = await DB.updateWorkplace(Object.fromEntries(new FormData(e.target)));
        toast('업장 정보를 저장했습니다');
        renderMe();
      } catch (ex) {
        toast(ex.message);
      }
    });
    $view.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
      await DB.approveMember(b.dataset.approve);
      toast('가입을 승인했습니다');
      renderMe();
    }));
    $view.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
      const ok = await dialog({
        title: '가입을 거절할까요?',
        body: `<p><b>${esc(b.dataset.name)}</b> 님의 가입 신청이 삭제됩니다. 필요하면 다시 가입할 수 있습니다.</p>`,
        actions: [{ label: '취소', value: false }, { label: '거절', value: true, cls: 'danger-fill' }],
      });
      if (!ok) return;
      await DB.rejectMember(b.dataset.reject);
      toast('가입을 거절했습니다');
      renderMe();
    }));
    document.getElementById('logoutBtn').addEventListener('click', async () => {
      await DB.logout();
      user = null;
      location.hash = '#/login';
    });
  }

  // ---------- 개인정보 처리방침 / 동의 ----------
  function renderPrivacy() {
    h(`
      <header class="top"><a href="${user ? '#/me' : '#/login'}" class="back">‹</a><h1>개인정보 처리방침</h1></header>
      <div class="review policy">${Policy.policyPage}</div>
    `);
  }

  // 기존 회원 또는 고지문이 바뀐 경우: 동의해야 계속 쓸 수 있다
  function renderConsent() {
    h(`
      <div class="auth consent-page">
        <img class="auth-logo" src="/icons/icon-192.png" alt="">
        <h1>개인정보 처리 동의</h1>
        <p class="muted">계속 이용하려면 아래 내용을 확인하고 동의해 주세요</p>
        <div class="auth-form">
          <div class="consent">
            <label class="check"><input type="checkbox" id="agreeBox"> <span><b>[필수]</b> 개인정보 수집·이용, 처리 위탁 및 국외 이전에 동의합니다</span></label>
            <details open><summary>내용 보기</summary>${Policy.privacyConsent}</details>
            <a href="#/privacy" class="policy-link">개인정보 처리방침</a>
          </div>
          <p class="form-err" id="consentErr" hidden></p>
          <button class="btn primary" id="agreeBtn">동의하고 계속하기</button>
          <button class="btn text" id="consentLogout">동의하지 않고 로그아웃</button>
        </div>
      </div>
    `);
    document.getElementById('agreeBtn').addEventListener('click', async () => {
      const err = document.getElementById('consentErr');
      if (!document.getElementById('agreeBox').checked) {
        err.textContent = '동의 항목을 체크해 주세요';
        err.hidden = false;
        return;
      }
      user = await DB.agreePrivacy(Policy.PRIVACY_VERSION);
      await refreshBadge();
      location.hash = '#/';
    });
    document.getElementById('consentLogout').addEventListener('click', async () => {
      await DB.logout();
      user = null;
      location.hash = '#/login';
    });
  }

  // 업장코드로 가입했지만 아직 관리자 승인 전
  function renderPending() {
    h(`
      <div class="auth">
        <img class="auth-logo" src="/icons/icon-192.png" alt="">
        <h1>승인을 기다리고 있습니다</h1>
        <p class="muted">${user.workplace.status === 'pending'
          ? `새 업장 <b>${esc(user.workplace.code || '')}</b>의 개설을 서비스 운영자가 확인하고 있습니다. 확인되면 바로 이용할 수 있습니다.`
          : `업장 <b>${esc(user.workplace.code || user.workplace.hotelName)}</b>의 관리자가 가입을 승인하면 문서함과 재고를 이용할 수 있습니다.`}</p>
        <div class="auth-form">
          <button class="btn primary" id="pendingCheck">승인됐는지 다시 확인</button>
          <button class="btn text" id="pendingLogout">로그아웃</button>
          <button class="btn text danger" id="pendingCancel">가입 신청 취소 (탈퇴)</button>
        </div>
      </div>
    `);
    document.getElementById('pendingCheck').addEventListener('click', async () => {
      user = await DB.refreshMe();
      if (user.status === 'pending') return toast('아직 승인 전입니다');
      await refreshBadge();
      location.hash = '#/';
    });
    document.getElementById('pendingLogout').addEventListener('click', async () => {
      await DB.logout();
      user = null;
      location.hash = '#/login';
    });
    document.getElementById('pendingCancel').addEventListener('click', async () => {
      const p = dialog({
        title: '가입 신청을 취소할까요?',
        body: '<p>계정이 삭제됩니다.</p><label class="field"><span class="lbl">비밀번호 확인</span><input type="password" id="cancelPw" autocomplete="current-password"></label>',
        actions: [{ label: '닫기', value: false }, { label: '가입 취소', value: true, cls: 'danger-fill' }],
      });
      const pw = document.getElementById('cancelPw');
      pw.focus();
      if (!(await p)) return;
      try {
        await DB.deleteAccount(pw.value);
        user = null;
        location.hash = '#/login';
      } catch (ex) {
        toast(ex.message);
      }
    });
  }

  // ---------- 라우터 ----------
  async function route() {
    const [path, qs] = (location.hash.slice(1) || '/').split('?');
    const params = new URLSearchParams(qs || '');
    const parts = path.split('/').filter(Boolean);
    if (!user && !['login', 'privacy'].includes(parts[0])) return (location.hash = '#/login');
    if (user && parts[0] === 'login') return (location.hash = '#/');
    // 최신 개인정보 고지에 동의하지 않은 회원(기존 회원·문구 변경)은 동의 화면부터
    if (user?.privacyConsentRequired && !['consent', 'privacy'].includes(parts[0])) return (location.hash = '#/consent');
    if (user && !user.privacyConsentRequired && parts[0] === 'consent') return (location.hash = '#/');
    // 업장 관리자 승인 전에는 대기 화면만
    if (user?.status === 'pending' && !user.privacyConsentRequired && !['pending', 'privacy'].includes(parts[0])) return (location.hash = '#/pending');
    if (user && user.status !== 'pending' && parts[0] === 'pending') return (location.hash = '#/');
    if (parts[0] !== 'camera') stopCamera();
    const fullscreen = ['camera', 'process', 'login', 'consent', 'pending'].includes(parts[0]) || (parts[0] === 'privacy' && !user);
    $tabbar.hidden = fullscreen;
    document.body.classList.toggle('fullscreen', fullscreen);
    $tabbar.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === (parts[0] || 'home')));

    switch (parts[0]) {
      case 'login': return renderLogin(params);
      case 'privacy': return renderPrivacy();
      case 'consent': return renderConsent();
      case 'pending': return renderPending();
      case 'me': return renderMe();
      case 'camera': return renderCamera(params);
      case 'process': return renderProcess(parts[1]);
      case 'retake': return renderRetake(parts[1]);
      case 'review': return renderReview(parts[1]);
      case 'queue': return renderList('queue');
      case 'inventory': return parts[1] ? renderInventoryItem(parts[1]) : renderInventory();
      default: return renderList('home');
    }
  }

  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason?.status === 401) return; // auth-required 이벤트가 처리
    toast(e.reason?.message || '요청에 실패했습니다');
  });
  window.addEventListener('auth-required', () => {
    user = null;
    if (!location.hash.startsWith('#/login')) location.hash = '#/login';
  });

  (async () => {
    try {
      user = await DB.currentUser();
    } catch (e) {
      if (e.status !== 401) {
        $tabbar.hidden = true;
        h(`<div class="empty"><div class="empty-ico">⚠️</div><p>서버에 연결할 수 없습니다.<br>${esc(e.message)}</p>
          <button class="btn primary" id="retryBtn">다시 시도</button></div>`);
        document.getElementById('retryBtn').addEventListener('click', () => location.reload()); // CSP: 인라인 onclick 금지
        return;
      }
      user = null;
    }
    if (user && !user.privacyConsentRequired && user.status !== 'pending') { // 동의 전·승인 전에는 문서 API를 쓸 수 없다
      // 인식 도중 앱이 닫힌 지 10분 넘은 문서는 재촬영 대상으로 돌린다
      const stale = Date.now() - 10 * 60_000;
      for (const { doc } of await DB.listDocuments()) {
        if (doc.status === 'processing' && new Date(doc.createdAt).getTime() < stale) {
          await DB.setStatus(doc.id, 'needs_retake', { retakeReason: '인식이 중단되었습니다.' });
        }
      }
      await refreshBadge();
    }
    window.addEventListener('hashchange', route);
    route();
  })();
})();
