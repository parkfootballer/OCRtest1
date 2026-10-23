// 화면 라우팅과 촬영 → 인식 → 대조 → 검수 흐름
(() => {
  const $view = document.getElementById('view');
  const $tabbar = document.getElementById('tabbar');
  const fmt = Parser.fmt;
  let user;
  let stream; // 카메라 MediaStream

  const STATUS = {
    processing: ['인식 중', 'st-proc'],
    needs_retake: ['재촬영 필요', 'st-retake'],
    needs_review: ['검수 대기', 'st-review'],
    verified: ['완료', 'st-ok'],
  };
  const FIELDS = [
    ['vendorName', '상호(업체명)', 'text'],
    ['businessNumber', '사업자등록번호', 'text'],
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
  const dateLabel = (iso) => new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

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
        <h1>${mode === 'queue' ? '검수함' : '문서함'}</h1>
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
              <div class="row2">${typeLabel(doc.documentType)} · ${dateLabel(doc.createdAt)}</div>
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
        <video id="video" playsinline muted autoplay></video>
        <div class="frame"><i></i><i></i><i></i><i></i></div>
        <div class="cam-top">
          <a href="#/" class="icon-btn" aria-label="닫기">✕</a>
          <span class="cam-title">${retakeId ? '재촬영' : '문서 촬영'}</span>
          <button class="icon-btn" id="sampleBtn" title="샘플 문서로 시험">샘플</button>
        </div>
        <div class="cam-hint" id="camHint">문서의 네 모서리를 가이드 안에 맞춰 주세요</div>
        <div class="cam-bottom">
          <div class="types">${Object.entries(Parser.DOC_TYPES).map(([k, v]) =>
            `<button data-type="${k}" class="${k === docType ? 'on' : ''}">${v}</button>`).join('')}</div>
          <div class="controls">
            <label class="icon-btn lg" aria-label="앨범에서 선택">🖼<input type="file" accept="image/*" id="fileInput" hidden></label>
            <button class="shutter" id="shutter" aria-label="촬영"></button>
            <label class="icon-btn lg" aria-label="기본 카메라 앱">📷<input type="file" accept="image/*" capture="environment" id="nativeInput" hidden></label>
          </div>
        </div>
        <div class="sample-sheet" id="sampleSheet" hidden>
          <p>카메라 없이 시험할 샘플 문서</p>
          <button data-sample="invoice">거래명세서 샘플</button>
          <button data-sample="giro">지로 고지서 샘플</button>
          <button class="ghost" data-sample="">취소</button>
        </div>
      </div>
    `);

    const video = document.getElementById('video');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } }, audio: false,
      });
      video.srcObject = stream;
    } catch (e) {
      document.getElementById('camHint').textContent = '카메라를 사용할 수 없습니다. 앨범 또는 샘플을 이용하세요.';
      document.getElementById('shutter').disabled = true;
    }

    $view.querySelectorAll('.types button').forEach((b) => b.addEventListener('click', () => {
      docType = b.dataset.type;
      $view.querySelectorAll('.types button').forEach((x) => x.classList.toggle('on', x === b));
    }));

    const go = (dataUrl) => capture(dataUrl, docType, retakeId);

    document.getElementById('shutter').addEventListener('click', () => {
      if (!video.videoWidth) return;
      const c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      document.querySelector('.camera').classList.add('flash');
      go(c.toDataURL('image/jpeg', 0.92));
    });
    const onFile = (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => go(r.result);
      r.readAsDataURL(f);
    };
    document.getElementById('fileInput').addEventListener('change', onFile);
    document.getElementById('nativeInput').addEventListener('change', onFile);

    const sheet = document.getElementById('sampleSheet');
    document.getElementById('sampleBtn').addEventListener('click', () => { sheet.hidden = false; });
    sheet.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      sheet.hidden = true;
      if (b.dataset.sample) go(Samples[b.dataset.sample]());
    }));
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    document.body.classList.remove('dark');
  }

  async function capture(dataUrl, docType, retakeId) {
    const imageUrl = await OCR.downscale(dataUrl);
    let doc;
    if (retakeId) {
      doc = await DB.setStatus(retakeId, 'processing', { imageUrl, ...(docType !== 'auto' ? { documentType: docType } : {}) });
    } else {
      doc = await DB.createDocument({ userId: user.id, documentType: docType, imageUrl });
    }
    location.hash = `#/process/${doc.id}`;
  }

  // ---------- 인식 처리 ----------
  async function renderProcess(id) {
    const { doc } = await DB.documentBundle(id);
    const steps = ['촬영 품질 검사', '텍스트 인식 (OCR)', '정보 추출', '데이터 대조'];
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
      step(2, 'done', `${parsed.lineItems.length}개 품목`);
      bar(0.92);

      step(3, 'active');
      const checks = Parser.validate(parsed.data, parsed.lineItems, parsed.documentType);
      const errors = checks.filter((c) => c.level === 'error').length;
      const warns = checks.filter((c) => c.level === 'warn').length;
      step(3, errors ? 'warn' : 'done', errors || warns ? `오류 ${errors} · 주의 ${warns}` : '모두 일치');
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
      if (!confirm('이 문서를 삭제할까요?')) return;
      await DB.deleteDocument(id);
      await refreshBadge();
      location.hash = '#/';
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

    h(`
      <header class="top"><a href="#/" class="back">‹</a><h1>검수</h1>${badge(doc.status)}</header>
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

        <section class="card">
          <div class="card-h"><h2>추출 정보</h2></div>
          <form id="fieldsForm">${FIELDS.map(fieldInput).join('')}</form>
        </section>

        <section class="card">
          <div class="card-h"><h2>거래 상세 항목</h2><button class="ghost sm" id="addItem">+ 추가</button></div>
          <div id="items"></div>
        </section>

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
          <input class="name" data-k="itemName" value="${esc(it.itemName)}" placeholder="품목명">
          <div class="nums">
            <input data-k="quantity" inputmode="numeric" value="${esc(it.quantity)}" placeholder="수량">
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
      it[k] = k === 'itemName' ? e.target.value : Parser.toNumber(e.target.value);
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
      items.push({ itemName: '', quantity: 1, unitPrice: null, amount: null });
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

    // 저장: 바뀐 필드마다 ReviewLog를 남긴다
    document.getElementById('saveBtn').addEventListener('click', async () => {
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
      const itemsKey = (arr) => JSON.stringify(arr.map((i) => [i.itemName, +i.quantity || 0, +i.unitPrice || 0, +i.amount || 0]));
      if (itemsKey(items) !== itemsKey(b.items)) changes.push(['lineItems', `${b.items.length}개 품목`, `${items.length}개 품목`]);

      for (const [fieldName, o, c] of changes) {
        await DB.logReview({ documentId: id, reviewerId: user.id, fieldName, originalValue: o, correctedValue: c });
      }
      const { id: _exId, documentId: _d, ...exRest } = ex;
      const cleanItems = items.filter((i) => i.itemName || i.amount)
        .map(({ itemName, quantity, unitPrice, amount }) => ({ itemName, quantity, unitPrice, amount }));
      await DB.saveExtraction(id, { ...exRest, ...cur }, cleanItems);
      await DB.setStatus(id, 'verified', { documentType: newType, verifiedBy: user.id, verifiedAt: new Date().toISOString() });
      await refreshBadge();
      toast(changes.length ? `${changes.length}개 항목을 수정해 저장했습니다` : '검수 완료로 저장했습니다');
      location.hash = '#/';
    });
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
    const cfg = mode === 'signup' ? await DB.authConfig().catch(() => ({})) : {};
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
          ${mode === 'signup' ? '<label class="field"><span class="lbl">이름</span><input name="name" autocomplete="name" required></label>' : ''}
          <label class="field"><span class="lbl">이메일</span><input name="email" type="email" autocomplete="email" inputmode="email" required></label>
          <label class="field"><span class="lbl">비밀번호${mode === 'signup' ? ' (8자 이상)' : ''}</span>
            <input name="password" type="password" minlength="${mode === 'signup' ? 8 : 1}" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" required></label>
          ${cfg.signupCodeRequired ? '<label class="field"><span class="lbl">초대 코드</span><input name="code" autocomplete="off" required></label>' : ''}
          <p class="form-err" id="authErr" hidden></p>
          <button class="btn primary" type="submit">${mode === 'signup' ? '가입하고 시작하기' : '로그인'}</button>
        </form>
      </div>
    `);
    document.getElementById('authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const btn = e.target.querySelector('button');
      const err = document.getElementById('authErr');
      btn.disabled = true;
      err.hidden = true;
      try {
        user = mode === 'signup' ? await DB.signup(f) : await DB.login(f.email, f.password);
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
  function renderMe() {
    const st = installState();
    h(`
      <header class="top"><a href="#/" class="back">‹</a><h1>내 정보</h1></header>
      <div class="review">
        <section class="card profile">
          <span class="avatar lg">${esc((user.name || '?').slice(0, 1))}</span>
          <div><b>${esc(user.name)}</b><p class="muted">${esc(user.email)}</p></div>
        </section>
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
        <section class="card">
          <div class="card-h"><h2>데이터</h2></div>
          <button class="btn ghost block" id="exportBtn">전체 데이터 내보내기 (JSON)</button>
        </section>
        <button class="btn text danger" id="logoutBtn">로그아웃</button>
      </div>
    `);
    document.getElementById('installBtn')?.addEventListener('click', async () => {
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      renderMe();
    });
    document.getElementById('exportBtn').addEventListener('click', async () => {
      const data = await DB.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `chalkak-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
    });
    document.getElementById('logoutBtn').addEventListener('click', async () => {
      await DB.logout();
      user = null;
      location.hash = '#/login';
    });
  }

  // ---------- 라우터 ----------
  async function route() {
    const [path, qs] = (location.hash.slice(1) || '/').split('?');
    const params = new URLSearchParams(qs || '');
    const parts = path.split('/').filter(Boolean);
    if (!user && parts[0] !== 'login') return (location.hash = '#/login');
    if (user && parts[0] === 'login') return (location.hash = '#/');
    if (parts[0] !== 'camera') stopCamera();
    const fullscreen = ['camera', 'process', 'login'].includes(parts[0]);
    $tabbar.hidden = fullscreen;
    document.body.classList.toggle('fullscreen', fullscreen);
    $tabbar.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === (parts[0] || 'home')));

    switch (parts[0]) {
      case 'login': return renderLogin(params);
      case 'me': return renderMe();
      case 'camera': return renderCamera(params);
      case 'process': return renderProcess(parts[1]);
      case 'retake': return renderRetake(parts[1]);
      case 'review': return renderReview(parts[1]);
      case 'queue': return renderList('queue');
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
        return h(`<div class="empty"><div class="empty-ico">⚠️</div><p>서버에 연결할 수 없습니다.<br>${esc(e.message)}</p>
          <button class="btn primary" onclick="location.reload()">다시 시도</button></div>`);
      }
      user = null;
    }
    if (user) {
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
