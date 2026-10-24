// OCR 결과 → ExtractedData / LineItem 변환, 그리고 대조(검증) 규칙.
// 글자 상자 위치(ocr.words / ocr.lines[].box)가 있으면 "라벨 오른쪽·아래 칸" 규칙으로 값을 찾고,
// 위치가 없으면(예전 Tesseract 결과) 줄 단위로 같은 규칙을 적용한다.
const Parser = (() => {
  const DOC_TYPES = {
    auto: '자동 판별',
    giro: '지로',
    bill: '고지서',
    invoice: '거래명세서',
    tax_invoice: '세금계산서',
  };
  const isBillType = (t) => t === 'giro' || t === 'bill';

  const BIZ_RE = /(\d{3})\s*[-–]\s*(\d{2})\s*[-–]\s*(\d{5})/g;
  const BIZ_ONE = new RegExp(BIZ_RE.source);
  const DATE_RE = /(20\d{2})\s*[.\-–—/년]\s*(\d{1,2})\s*[.\-–—/월]\s*(\d{1,2})\s*일?/g;
  const compact = (s) => String(s || '').replace(/\s+/g, '');
  const labelText = (s) => compact(s).replace(/['`"‘’·]/g, ''); // 라벨 비교용: OCR 잡음 문장부호 제거
  const pad = (n) => String(n).padStart(2, '0');

  // 라벨 패턴: '[납남]기내금액'처럼 OCR이 자주 헷갈리는 글자는 문자 클래스로 쓴다
  const LABEL = {
    supplierHdr: /^공급자(?!용)/,
    customerHdr: /^공급받는자(?!용)/,
    sangho: /^상[호초](명)?/,
    custName: /^고객명|^고객성명|^성명/,
    issue: /^(발행일|작성일자?|거래일자?|청구일|고지일)/,
    due: /^([납남][부입]기한|[납남]부마감일?|[납남]기일|[납남]기내(?!금액)|마감일|지불기한)/,
    billTotal: [/^[납남]기내금[액역]/, /^청구금[액역]/, /^[납남]부하실금[액역]/, /^당월부과[액역]계?/, /^당월계/, /^[납남]부(할)?금[액역](?!내역)/, /^[합함]계(?!금)/],
    billIssuer: /^(수납기관|청구기관|발행처|발행기관)/,
    invTotal: [/^[합함]계금[액역억엑맥]/, /^총[합함]계/, /^청구금[액역]/, /^[합함]계/],
    tax: /^(부가가치세|부가세|세[액역억엑]|VAT)/i,
    supply: /^공급가(액)?/,
    docNo: [/^(문서번호|일련번호|전표번호|거래번호|명세서번호|관리번호|발행번호)/, /^(No\.?|NO\.?|№)(?![A-Za-z])/],
  };
  const NOT_VALUE = /^(번호|등록번호|전화|이름|대표|성명|주소|상호|공급|고객|합계|금액|단가|수량|규격|품명|사업자)/;

  function classify(text) {
    const t = compact(text);
    if (/거래명세/.test(t)) return 'invoice';
    if (/세금계산서/.test(t) && !/고지|관리비|요금|지로/.test(t)) return 'tax_invoice';
    if (/지로/.test(t)) return 'giro';
    if (/고지|관리비|청구서|납부|요금/.test(t)) return 'bill';
    return 'invoice';
  }

  function toNumber(s) {
    if (s == null) return null;
    const n = parseInt(String(s).replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  function checkBizNumber(num) {
    const d = String(num || '').replace(/\D/g, '').split('').map(Number);
    if (d.length !== 10) return false;
    const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
    let sum = w.reduce((s, wi, i) => s + wi * d[i], 0);
    sum += Math.floor((d[8] * 5) / 10);
    return (10 - (sum % 10)) % 10 === d[9];
  }

  // 문자열 유사도 0~1 (편집거리 기반) — 거래처 기억 매칭에 쓴다
  function similarity(a, b) {
    a = compact(a); b = compact(b);
    if (!a || !b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length);
  }

  // ---------- 값 해석 ----------
  // 문자열에서 첫 금액. 날짜·전화·사업자번호·단위 붙은 숫자(12㎡, 355Kwh, 8차)는 건너뛴다
  function amountPick(s) {
    const t = String(s).replace(DATE_RE, ' ').replace(BIZ_RE, ' ').replace(/\d{2,4}\s*[-–)]\s*\d{3,4}\s*[-–]\s*\d{4}/g, ' ');
    for (const m of t.matchAll(/-?\d[\d,.\s]*\d|-?\d/g)) {
      const raw = m[0].trim();
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 4);
      if (/^\s*(m|㎡|kwh|k|월|일|년|호|%|차|동|번|층|개월|원\/)/i.test(after)) continue;
      const before = t.slice(Math.max(0, m.index - 1), m.index);
      if (/[A-Za-z]/.test(before)) continue;
      const tok = raw.replace(/\s+/g, '');
      // 1,234 / 1.234 / 1234 형식만 금액으로 본다 (3자리 구분이 아니면 소수 등)
      if (/[,.]/.test(tok) && !/^-?\d{1,3}([,.]\d{3})+$/.test(tok)) continue;
      if (tok.replace(/\D/g, '').length > 12) continue; // 계좌·조회번호 같은 긴 숫자
      const n = toNumber(tok);
      if (n == null) continue;
      return tok.startsWith('-') ? -n : n;
    }
    return null;
  }

  // ctx: { year, month } — "09 월 30 일", "매월30일"처럼 연도가 없는 날짜를 채운다
  function datePick(s, ctx = {}) {
    s = String(s);
    for (const m of s.matchAll(DATE_RE)) {
      const y = +m[1], mo = +m[2], d = +m[3];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad(mo)}-${pad(d)}`;
    }
    let m = s.match(/(?:^|[^\d])(\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
    if (m) return `20${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    m = s.match(/(?:^|[^\d])(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
    if (m && ctx.year) {
      const mo = +m[1];
      const y = ctx.month && mo < ctx.month - 6 ? ctx.year + 1 : ctx.year; // 12월분 → 1월 납부
      return `${y}-${pad(mo)}-${pad(m[2])}`;
    }
    m = s.match(/매월\s*(\d{1,2})\s*일/);
    if (m && ctx.year && ctx.month) return `${ctx.year}-${pad(ctx.month)}-${pad(m[1])}`;
    return null;
  }

  function cleanName(s, keepAt = false) {
    let t = String(s)
      .replace(/^[\s:：|\][)\-–.,·]+/, '')
      .split(/\s{2,}|\s(?=(?:번\s*호|전\s*화|이\s*름|대\s*표|성\s*명|등\s*록|주\s*소|TEL|Tel|FAX)\b)|TEL|Tel|FAX|☎|\|/)[0];
    t = t.replace(keepAt ? /[^\p{L}\p{N}()㈜&.@\s-]/gu : /[^\p{L}\p{N}()㈜&.\s-]/gu, '').trim();
    t = t.replace(/\s*(귀하|고객님|님)$/, '').trim();
    return t;
  }
  // 문서번호: 숫자가 들어간 4~30자 영숫자(-, / 허용). 날짜·사업자번호·전화번호는 제외
  const docNoPick = (s) => {
    const t = String(s).replace(/^[\s:：#.\-]+/, '');
    if (new RegExp(DATE_RE.source).test(t) || BIZ_ONE.test(t)) return null;
    const m = t.match(/^[A-Za-z0-9][A-Za-z0-9\-/]{3,29}/);
    if (!m || !/\d/.test(m[0]) || /^\d{2,4}-\d{3,4}-\d{4}$/.test(m[0])) return null;
    return m[0].toUpperCase();
  };
  const textPick = (keepAt) => (s) => {
    const t = cleanName(s, keepAt);
    if (compact(t).length < 2 || NOT_VALUE.test(compact(t)) || /^[\d\s,.-]+$/.test(t)) return null;
    return t;
  };

  // ---------- 글자 상자 준비 ----------
  function prepare(ocr) {
    const rawText = String(ocr.text || '').trim();
    let lines = (ocr.lines && ocr.lines.length ? ocr.lines : rawText.split('\n').map((t) => ({ text: t })))
      .map((l, i) => ({
        text: String(l.text || '').trim(),
        conf: (l.confidence ?? ocr.confidence ?? 0) / 100,
        box: l.box || [0, i * 20, 1000, i * 20 + 18], // 위치가 없으면 줄 순서대로 쌓인 가상 상자
        words: l.words,
      }))
      .filter((l) => l.text);
    const mk = (text, conf, box) => ({
      text, c: labelText(text), conf,
      x0: box[0], y0: box[1], x1: box[2], y1: box[3],
      cx: (box[0] + box[2]) / 2, cy: (box[1] + box[3]) / 2, h: Math.max(1, box[3] - box[1]),
    });
    let words;
    if (ocr.words && ocr.words.length) {
      words = ocr.words.map((w) => mk(String(w.text).trim(), (w.confidence ?? 0) / 100, w.box)).filter((w) => w.c);
    } else {
      words = lines.map((l) => mk(l.text, l.conf, l.box));
    }
    lines = lines.map((l) => ({
      ...l,
      words: l.words ? l.words.map((w) => mk(String(w.text).trim(), (w.confidence ?? 0) / 100, w.box)).filter((w) => w.c) : null,
    }));
    return { rawText, lines, words };
  }

  // 값이 읽힌 글자 상자 [x0, y0, x1, y1] — 검수 후 학습 데이터에서 "이 위치의 글자는 원래 이것"을 만드는 데 쓴다
  const boxOf = (w) => [w.x0, w.y0, w.x1, w.y1].map(Math.round);

  // 라벨 상자 기준으로 값 찾기: ① 같은 상자 안 라벨 뒤 ② 같은 줄 오른쪽 ③ 바로 아래
  function valueNear(words, label, re, pick, { right = true, below = true, maxRight = 40 } = {}) {
    // ① 라벨 뒤 글자: 원문에서 라벨 길이만큼(공백 무시) 건너뛴 나머지
    const m = label.c.match(re);
    if (m) {
      let n = m.index + m[0].length, i = 0;
      const t = label.text;
      while (i < t.length && n > 0) { if (!/\s/.test(t[i])) n--; i++; }
      // "고객명(Name)", "납부마감일(Due date)"의 영문 괄호 설명은 값이 아님 ("(주)"는 값의 일부)
      const rest = t.slice(i).replace(/^\s*(?:\([A-Za-z .]*\))?[\s:：\-–)]*/, '');
      if (rest) { const v = pick(rest); if (v != null) return { value: v, conf: label.conf, box: boxOf(label) }; }
    }
    const L = label;
    if (right) {
      const cands = words
        .filter((w) => w !== L && w.x0 >= L.x1 - L.h * 0.5 && w.x0 - L.x1 < L.h * maxRight
          && Math.min(w.y1, L.y1) - Math.max(w.y0, L.y0) > Math.min(w.h, L.h) * 0.45)
        .sort((a, b) => a.x0 - b.x0)
        .slice(0, 3);
      for (const w of cands) { const v = pick(w.text); if (v != null) return { value: v, conf: Math.min(w.conf, L.conf), box: boxOf(w) }; }
    }
    if (below) {
      const cands = words
        .filter((w) => w !== L && w.y0 > L.cy && w.y0 - L.y1 < L.h * 2.2
          && Math.min(w.x1, L.x1 + L.h * 4) - Math.max(w.x0, L.x0 - L.h * 2) > 0)
        .sort((a, b) => a.y0 - b.y0 || Math.abs(a.cx - L.cx) - Math.abs(b.cx - L.cx))
        .slice(0, 2);
      for (const w of cands) { const v = pick(w.text); if (v != null) return { value: v, conf: Math.min(w.conf, L.conf) * 0.9, box: boxOf(w) }; }
    }
    return null;
  }

  function findField(words, res, pick, opts) {
    for (const re of [].concat(res)) {
      for (const w of words.filter((x) => re.test(x.c))) {
        const v = valueNear(words, w, re, pick, opts);
        if (v) return { ...v, label: w };
      }
    }
    // 라벨이 칸 중간에 있는 경우("공급가:241,500 + 세액:0")는 라벨 뒤 글자만 본다
    for (const re of [].concat(res)) {
      const mid = new RegExp(re.source.replace(/^\^/, ''), re.flags);
      for (const w of words.filter((x) => !re.test(x.c) && mid.test(x.c))) {
        const v = valueNear(words, w, mid, pick, { right: false, below: false });
        if (v) return { ...v, label: w };
      }
    }
    return null;
  }

  // ---------- 거래명세서 품목 표 ----------
  function extractItems(lines) {
    const items = [];
    const hdr = lines.findIndex((l) => /품[명목]/.test(compact(l.text)) && /수량|단가|금액/.test(compact(l.text)));
    const start = hdr >= 0 ? hdr + 1 : 0;
    const isNum = (s) => /^-?\d[\d,.]*$/.test(compact(s));
    for (let i = start; i < lines.length; i++) {
      const l = lines[i];
      const c = compact(l.text);
      if (hdr >= 0 && /합계|이하여백|소계|공급가|총잔액/.test(c)) break;
      if (/합계|총액|소계|공급가액|세액|부가세|청구금액|납부금액/.test(c)) continue;
      // 상자 단위가 있으면 상자로, 없으면 공백으로 나눈 토큰으로
      const toks = l.words && l.words.length
        ? l.words.map((w) => w.text)
        : l.text.split(/\s+/);
      for (let k = toks.length - 3; k >= 0; k--) {
        if (!isNum(toks[k]) || !isNum(toks[k + 1]) || !isNum(toks[k + 2])) continue;
        const q = toNumber(toks[k]), u = toNumber(toks[k + 1]), a = toNumber(toks[k + 2]);
        if (!q || !u || !a || q > 100000 || Math.abs(q * u - a) > 1) continue;
        const left = toks.slice(0, k).filter((t) => !isNum(t) || /[^\d,.]/.test(t));
        if (!left.length) break;
        let name = left[0];
        let unit = null;
        if (left.length > 1 && compact(left[left.length - 1]).length <= 3) unit = compact(left.pop());
        const spec = left.slice(1).join(' ') || null;
        name = name.replace(/^\s*\d+[.)]\s+/, '').trim();
        if (!/[\p{L}]/u.test(name)) break;
        items.push({ itemName: name, spec, unit, quantity: q, unitPrice: u, amount: a });
        break;
      }
    }
    return items;
  }

  // ---------- 고지서 부과 항목 ----------
  // "일반관리비 64,686"처럼 항목명 오른쪽 금액. 같은 항목이 여러 번 나오면 아래쪽(납입영수증) 값을 쓴다
  const FEE_NAME = /^(수도|전기|가스|기타|[가-힣A-Z]{1,10}(비|료|요금|충당금|기금|세|액|수거|유지|쓰레기?)(\(비\))?)$/;
  const FEE_EXCLUDE = /합계|[납남]기|부과액|연체|미납액|청구|금액|공급가|과세|비과세|사용량|관리비가|고지|단가|할인|감면|부과$|^당월|^전월|^계$|^부가세$/;
  const BARE_FEE = /^(수도|전기|가스|기타)$/; // 사용량 표에도 나오는 짧은 이름
  // "전기249Kwh", ":수도13m" 같은 칸에서 앞쪽 항목명만 떼어 낸다
  function feeHead(c) {
    const m = c.replace(/^[^가-힣A-Z]+/, '').match(/^([가-힣A-Z]+(?:\(비\))?)(.*)$/);
    if (!m || !FEE_NAME.test(m[1]) || FEE_EXCLUDE.test(m[1])) return null;
    if (m[2] && !/^\d+(kwh|m2|m³|㎥|㎡|m)?$/i.test(m[2])) return null;
    return m[1];
  }
  function extractBillItems(words) {
    const rows = [...words].sort((a, b) => a.cy - b.cy || a.x0 - b.x0);
    const byName = new Map();
    for (const w of rows) {
      // "전기요금:78,400원"처럼 이름과 금액이 한 칸에 붙은 경우
      const inl = w.c.match(/^([가-힣A-Z]+(?:\(비\))?)[:：](-?\d{1,3}(?:,\d{3})+|-?\d+)원?$/);
      if (inl && FEE_NAME.test(inl[1]) && !FEE_EXCLUDE.test(inl[1])) {
        byName.set(inl[1], { itemName: inl[1], quantity: null, unitPrice: null, amount: amountPick(inl[2]) });
        continue;
      }
      const name = feeHead(w.c);
      if (!name) continue;
      // 같은 줄 오른쪽, 다음 항목명 전까지의 금액들
      const seg = words
        .filter((o) => o !== w && o.x0 >= w.x1 - w.h * 0.3 && o.x0 - w.x1 < w.h * 14
          && Math.min(o.y1, w.y1) - Math.max(o.y0, w.y0) > Math.min(o.h, w.h) * 0.45)
        .sort((a, b) => a.x0 - b.x0);
      const amounts = [];
      for (const o of seg) {
        if (feeHead(o.c)) break;
        if (!/^[\d,.\-\s원]+$/.test(o.text)) continue;
        const v = amountPick(o.text);
        if (v == null || Math.abs(v) >= 1e9) continue;
        // 짧은 이름(전기·수도)은 사용량 숫자와 헷갈리므로 쉼표 있는 금액이나 0만
        if (BARE_FEE.test(name) && v !== 0 && !/,/.test(o.text)) continue;
        amounts.push(v);
      }
      if (!amounts.length) continue;
      // 전월·당월·증감 세 칸이면 가운데(당월), 아니면 마지막 금액
      let amount = amounts[amounts.length - 1];
      if (amounts.length === 3 && (amounts[2] < 0 || Math.abs(amounts[2]) < Math.min(amounts[0], amounts[1]) * 0.5)) amount = amounts[1];
      byName.set(name, { itemName: name, quantity: null, unitPrice: null, amount });
    }
    return [...byName.values()];
  }

  // ---------- 거래처 기억 ----------
  // memory.vendors / memory.customers: 이전에 사람이 검수해 확정한 이름 목록
  // 지점명처럼 한두 글자 차이가 다른 거래처일 수 있으므로 보수적으로 맞춘다:
  // 숫자가 다르면 안 맞춤, 비슷한 후보가 둘 이상이면 안 맞춤, 확신 있게 읽은 값은 거의 같을 때만 맞춤
  function snap(value, names, conf = 0) {
    if (!names || !names.length) return null;
    const digits = (s) => compact(s).replace(/\D/g, '');
    const scored = names
      .filter((n) => digits(n) === digits(value))
      .map((n) => ({ n, s: similarity(value, n) }))
      .sort((a, b) => b.s - a.s);
    if (!scored.length) return null;
    const [best, second] = scored;
    if (best.s === 1) return { value: best.n, sim: 1 };
    if (second && best.s - second.s < 0.08) return null;
    if (best.s >= 0.9 || (best.s >= 0.75 && conf < 0.93)) return { value: best.n, sim: best.s };
    return null;
  }
  // 값이 없을 때: 문서 전체 줄에서 기억된 이름이 거의 그대로 보이는지 찾는다
  function findKnown(lines, names, minSim = 0.85) {
    let best = null, bs = 0;
    for (const n of names || []) {
      const cn = compact(n);
      if (cn.length < 2) continue;
      for (const l of lines) {
        const c = compact(l.text);
        for (let i = 0; i + cn.length - 1 <= c.length + 1; i++) {
          const s = similarity(c.slice(i, i + cn.length), cn);
          if (s > bs) { bs = s; best = n; }
          if (bs === 1) return { value: best, sim: 1 };
        }
      }
    }
    return bs >= minSim ? { value: best, sim: bs } : null;
  }

  // 고지서 발행처 후보: 관리사무소·주택관리·에너지 등 접미어, 여러 번 등장, 맨 위·아래 위치에 점수
  function guessBillVendor(words, pageH) {
    const SUFFIX = /(주택관리|관리사무소|관리단|관리\(주\)|에너지|도시가스|전력공사|수자원공사|주식회사|㈜)$/;
    const NOISE = /고객|입니다|바랍니다|주십시오|하세요|납부|금액|안내|주소|번호|요금|고지서|영수증|명세서|내역서|지로|사용|기간|연체|계좌|예금주|은행|합계|현황|비교|항목|공지|센터|www|http|귀하|호$|^관리비|^\(?주\)?$|(충당금|기금|[^사]비|료|세)$/;
    const freq = {};
    const cands = [];
    for (const w of words) {
      const name = cleanName(w.text);
      const c = compact(name);
      if (c.length < 3 || c.length > 20 || !/[가-힣A-Z]/.test(c) || NOISE.test(c)) continue;
      freq[c] = (freq[c] || 0) + 1;
      cands.push({ name, c, w });
    }
    let best = null, bs = 0;
    for (const x of cands) {
      let s = 0;
      if (SUFFIX.test(x.c)) s += 3;
      s += Math.min(2, (freq[x.c] - 1) * 1.5);
      const pos = x.w.cy / (pageH || 1);
      if (pos < 0.12 || pos > 0.88) s += 1;
      if (/\d{3,}/.test(x.c)) s -= 2;
      if (s > bs) { bs = s; best = x; }
    }
    if (!best || bs < 2.5) return null;
    // 로고처럼 두 줄로 나뉜 이름("CNCITY" 아래 "에너지")은 위·왼쪽 단어와 합친다
    let name = best.name;
    if (/^(에너지|도시가스|가스|관리사무소)$/.test(best.c)) {
      const b = best.w;
      const head = words.find((w) => w !== b && /^[A-Za-z가-힣][A-Za-z가-힣0-9]{1,15}$/.test(w.c) && !NOISE.test(w.c)
        && ((w.y1 <= b.y0 + b.h * 0.3 && b.y0 - w.y1 < b.h * 1.5 && Math.min(w.x1, b.x1) - Math.max(w.x0, b.x0) > -b.h)
          || (Math.abs(w.cy - b.cy) < b.h * 0.5 && w.x1 <= b.x0 && b.x0 - w.x1 < b.h * 2)));
      if (head) name = cleanName(head.text).split(/\s+/)[0] + ' ' + name;
    }
    return { value: name, conf: best.w.conf * Math.min(1, bs / 5) };
  }

  function billingMonthOf(lines) {
    const pats = [
      /(20\d{2}|\d{2})\s*년\s*(\d{1,2})\s*월\s*분/,
      /(20\d{2}|\d{2})\s*년\s*(\d{1,2})\s*월\s*(?:관리비|도시가스|전기|수도|요금|청구)/,
      /(20\d{2})\s*[.\-/]\s*(\d{1,2})\s*월?\s*분/,
    ];
    for (const re of pats) {
      for (const l of lines) {
        const m = l.text.match(re);
        if (m) {
          const y = m[1].length === 2 ? 2000 + +m[1] : +m[1];
          const mo = +m[2];
          if (mo >= 1 && mo <= 12) return { value: `${y}-${pad(mo)}`, conf: l.conf };
        }
      }
    }
    // "09월 도시가스 요금" + 사용기간 끝 날짜의 연도
    for (const l of lines) {
      const m = l.text.match(/(\d{1,2})\s*월\s*(?:도시가스|관리비|전기|수도)\s*요금/);
      if (m) {
        const yr = lines.map((x) => datePick(x.text)).find(Boolean);
        if (yr) return { value: `${yr.slice(0, 4)}-${pad(m[1])}`, conf: l.conf * 0.9 };
      }
    }
    // 사용기간 "A ~ B" 의 끝 날짜가 속한 달
    for (const l of lines) {
      if (!/사용|부터|~/.test(l.text)) continue;
      const ds = [...l.text.matchAll(DATE_RE)];
      if (ds.length >= 2) return { value: `${ds[1][1]}-${pad(ds[1][2])}`, conf: l.conf * 0.7 };
    }
    return null;
  }

  // 지로 OCR 줄 "<6380067+ +0310...+ +560003< <11<" 의 금액칸(마지막 한 자리는 검증번호)
  function giroAmount(lines) {
    for (const l of lines) {
      const c = compact(l.text);
      const m = c.match(/\+(\d{2,12})<<?\d{1,2}<?$/) || c.match(/\+(\d{2,12})<<\d{1,2}/);
      if (m && m[1].length >= 2) return { value: Math.floor(+m[1] / 10), conf: l.conf };
    }
    return null;
  }

  /**
   * @param ocr {text, confidence, lines:[{text, confidence, box?, words?}], words?:[{text, confidence, box}], height?}
   * @param typeHint 사용자가 고른 문서 종류 ('auto' 가능)
   * @param memory { vendors: [], customers: [] } 이전에 검수 확정한 이름 (선택)
   */
  function parse(ocr, typeHint = 'auto', memory = {}) {
    const { rawText, lines, words } = prepare(ocr);
    const documentType = typeHint === 'auto' ? classify(rawText) : typeHint;
    const bill = isBillType(documentType);
    const pageH = ocr.height || Math.max(1, ...words.map((w) => w.y1));
    const fc = {}; // 필드별 신뢰도 0~1
    const fieldBoxes = {}; // 필드별 값 위치 (학습 데이터용)
    const set = (obj, key, r, k = 1) => {
      if (!r || r.value == null) return;
      obj[key] = r.value;
      fc[key] = Math.max(0, Math.min(1, r.conf * k));
      if (r.box) fieldBoxes[key] = r.box; else delete fieldBoxes[key];
    };
    const d = {};

    // 사업자등록번호: 검증번호가 맞는 것 우선
    for (const w of words) {
      for (const m of w.text.matchAll(BIZ_RE)) {
        const n = `${m[1]}-${m[2]}-${m[3]}`;
        if (!d.businessNumber || (checkBizNumber(n) && !checkBizNumber(d.businessNumber))) set(d, 'businessNumber', { value: n, conf: w.conf, box: boxOf(w) });
      }
      if (d.businessNumber && checkBizNumber(d.businessNumber)) break;
    }

    // 청구년월 → 연도 없는 날짜의 기준
    set(d, 'billingMonth', billingMonthOf(lines));
    const ctx = d.billingMonth ? { year: +d.billingMonth.slice(0, 4), month: +d.billingMonth.slice(5) } : {};
    if (!ctx.year) { const any = lines.map((l) => datePick(l.text)).find(Boolean); if (any) ctx.year = +any.slice(0, 4); }

    // 상호(공급자) / 고객명(공급받는자)
    if (!bill) {
      const supHdr = words.find((w) => LABEL.supplierHdr.test(w.c));
      const cusHdr = words.find((w) => LABEL.customerHdr.test(w.c));
      const found = words.filter((w) => LABEL.sangho.test(w.c))
        .map((w) => ({ w, v: valueNear(words, w, LABEL.sangho, textPick(true)) }))
        .filter((x) => x.v);
      for (const x of found) {
        let isSupplier;
        const nearest = (hdr) => found.reduce((a, b) => (Math.abs(a.w.cx - hdr.cx) <= Math.abs(b.w.cx - hdr.cx) ? a : b));
        if (supHdr && cusHdr) isSupplier = Math.abs(x.w.cx - supHdr.cx) < Math.abs(x.w.cx - cusHdr.cx);
        else if (cusHdr && found.length > 1) isSupplier = x !== nearest(cusHdr);
        else if (supHdr && found.length > 1) isSupplier = x === nearest(supHdr);
        else isSupplier = words.some((o) => Math.abs(o.cy - x.w.cy) < x.w.h && BIZ_ONE.test(o.text));
        if (isSupplier && !d.vendorName) set(d, 'vendorName', { value: cleanName(x.v.value), conf: x.v.conf });
        else if (!isSupplier && !d.customerName) set(d, 'customerName', x.v);
      }
      if (!d.vendorName && found.length === 1 && !d.customerName) set(d, 'vendorName', found[0].v);
      // "공급자 상호: OO", "공급받는자: OO"처럼 라벨과 값이 한 칸에 붙은 양식
      const inline = { right: false, below: false };
      if (!d.vendorName) set(d, 'vendorName', findField(words, [/공급자상[호초](명)?[:：]?/, /^공급자[:：]/], textPick(false), inline));
      if (!d.customerName) set(d, 'customerName', findField(words, [/공급받는자상[호초](명)?[:：]?/, /^공급받는자[:：]/], textPick(true), inline));
      if (!d.vendorName) {
        const w = words.find((x) => /\(주\)|㈜|주식회사/.test(x.text) && !LABEL.sangho.test(x.c) && !/공급받는자/.test(x.c));
        if (w) set(d, 'vendorName', { value: cleanName(w.text.replace(/^.*?(상\s*호|공\s*급\s*자)\s*[:：]?\s*/, '')), conf: w.conf * 0.6 });
      }
    } else {
      set(d, 'vendorName', findField(words, LABEL.billIssuer, textPick(false), { maxRight: 12 }) || guessBillVendor(words, pageH));
      set(d, 'customerName', findField(words, LABEL.custName, textPick(true), { maxRight: 8 }));
      if (!d.customerName) {
        for (const l of lines) {
          const m = l.text.match(/(?:^|[,，]\s*)([^,，]{2,30}?)\s*고객님/);
          if (m && !/안녕|사용중/.test(m[1])) { set(d, 'customerName', { value: cleanName(m[1], true), conf: l.conf * 0.8 }); break; }
        }
      }
    }

    // 날짜
    if (!bill) set(d, 'issueDate', findField(words, LABEL.issue, (s) => datePick(s, ctx)));
    set(d, 'dueDate', findField(words, LABEL.due, (s) => datePick(s, ctx)));
    if (!d.dueDate) {
      for (const l of lines) {
        if (!/[납남]부마감|[납남]부기한|[납남]기/.test(compact(l.text))) continue;
        const v = datePick(l.text.replace(/^.*?(마감일?|기한|[납남]기일?)/, ''), ctx);
        if (v) { set(d, 'dueDate', { value: v, conf: l.conf * 0.8 }); break; }
      }
    }
    if (!bill && !d.issueDate) {
      const first = lines.map((l) => ({ v: datePick(l.text), conf: l.conf })).find((x) => x.v);
      if (first) set(d, 'issueDate', first, 0.6);
    }

    // 문서번호 (일련번호·전표번호 등) — 중복 문서 판단에 쓴다
    set(d, 'documentNumber', findField(words, LABEL.docNo, docNoPick, { maxRight: 12, below: false }));

    // 금액
    const posAmount = (s) => { const v = amountPick(s); return v != null && v >= 0 ? v : null; };
    if (bill) {
      const giro = giroAmount(lines);
      const labeled = findField(words, LABEL.billTotal, posAmount);
      // 지로 OCR 금액은 기계 판독용이라 가장 믿을 만하다. 라벨 값과 같으면 신뢰도 최고
      if (giro && labeled && giro.value === labeled.value) set(d, 'totalAmount', { value: giro.value, conf: 1 });
      else if (giro) set(d, 'totalAmount', giro, labeled ? 0.85 : 0.95); // 서로 다르면 기계 판독용 줄을 믿는다
      else set(d, 'totalAmount', labeled);
      if (!d.totalAmount) {
        for (const l of lines) {
          const m = l.text.match(/요금은\s*([\d,.\s]+)\s*원/);
          if (m) { set(d, 'totalAmount', { value: toNumber(m[1]), conf: l.conf * 0.8 }); break; }
        }
      }
    } else {
      set(d, 'totalAmount', findField(words, LABEL.invTotal, posAmount));
    }
    set(d, 'taxAmount', findField(words, LABEL.tax, (s) => amountPick(s), { below: false }));
    const supply = findField(words, LABEL.supply, posAmount, { below: false });
    if (d.totalAmount == null && supply && d.taxAmount != null) set(d, 'totalAmount', { value: supply.value + d.taxAmount, conf: supply.conf * 0.7 });

    // 거래처 기억으로 이름 보정 (OCR 오타를 확정된 이름으로 맞춤)
    for (const [key, list] of [['vendorName', memory.vendors], ['customerName', memory.customers]]) {
      if (!list || !list.length) continue;
      const hit = d[key] ? snap(d[key], list, fc[key]) : findKnown(lines, list);
      if (hit) set(d, key, { value: hit.value, conf: Math.max(fc[key] || 0, hit.sim) });
    }

    const lineItems = bill ? extractBillItems(words) : extractItems(lines);

    const ocrConf = (ocr.confidence || 0) / 100;
    const keyFields = bill ? ['vendorName', 'totalAmount', 'dueDate'] : ['vendorName', 'businessNumber', 'issueDate', 'totalAmount'];
    const coverage = keyFields.reduce((s, f) => s + (fc[f] || 0), 0) / keyFields.length;
    const confidenceScore = Math.round((ocrConf * 0.3 + coverage * 0.7) * 100) / 100;

    return {
      documentType,
      data: {
        vendorName: d.vendorName ?? null,
        businessNumber: d.businessNumber ?? null,
        customerName: d.customerName ?? null,
        issueDate: d.issueDate ?? null,
        dueDate: d.dueDate ?? null,
        billingMonth: d.billingMonth ?? null,
        documentNumber: d.documentNumber ?? null,
        totalAmount: d.totalAmount ?? null,
        taxAmount: d.taxAmount ?? null,
        rawText, confidenceScore, fieldConfidence: fc, ocrConfidence: ocrConf,
      },
      lineItems: lineItems.map(({ itemName, unit, quantity, unitPrice, amount }) => ({ itemName, unit: unit || null, quantity, unitPrice, amount })),
      fieldBoxes,
    };
  }

  // ---- 데이터 대조 ----
  function validate(ex, items, documentType) {
    const out = [];
    const push = (field, level, message) => out.push({ field, level, message });

    if (!ex.vendorName) push('vendorName', 'error', '상호(업체명)를 찾지 못했습니다.');
    if (ex.totalAmount == null) push('totalAmount', 'error', '합계 금액을 찾지 못했습니다.');

    if (ex.businessNumber) {
      if (checkBizNumber(ex.businessNumber)) push('businessNumber', 'ok', '사업자등록번호 검증번호 일치');
      else push('businessNumber', 'error', '사업자등록번호 검증번호가 맞지 않습니다. 숫자를 확인하세요.');
    } else if (documentType === 'invoice' || documentType === 'tax_invoice') {
      push('businessNumber', 'warn', '사업자등록번호를 찾지 못했습니다.');
    }

    if ((documentType === 'invoice' || documentType === 'tax_invoice') && ex.totalAmount && ex.taxAmount) {
      const supply = ex.totalAmount - ex.taxAmount;
      const ratio = ex.taxAmount / supply;
      if (Math.abs(ratio - 0.1) <= 0.005) push('taxAmount', 'ok', '세액 = 공급가액의 10% 일치');
      else push('taxAmount', 'warn', `세액이 공급가액(${fmt(supply)})의 10%와 다릅니다 (${(ratio * 100).toFixed(1)}%).`);
    }

    if (items.length) {
      const bad = items.filter((it) => it.quantity != null && it.unitPrice != null && Math.abs(it.quantity * it.unitPrice - it.amount) > 1);
      if (bad.length) push('lineItems', 'error', `수량×단가 ≠ 금액인 항목 ${bad.length}개`);
      const sum = items.reduce((s, it) => s + (+it.amount || 0), 0);
      if (ex.totalAmount != null) {
        const supply = ex.taxAmount ? ex.totalAmount - ex.taxAmount : ex.totalAmount;
        if (sum === ex.totalAmount || sum === supply) push('lineItems', 'ok', `품목 합계 ${fmt(sum)}원이 문서 금액과 일치`);
        else push('lineItems', 'warn', `품목 합계 ${fmt(sum)}원 ≠ ${ex.taxAmount ? '공급가액' : '합계'} ${fmt(supply)}원`);
      }
    }

    if (ex.issueDate && ex.dueDate && ex.dueDate < ex.issueDate) {
      push('dueDate', 'error', '납부기한이 발행일보다 앞섭니다.');
    }
    if ((documentType === 'giro' || documentType === 'bill') && !ex.dueDate) {
      push('dueDate', 'warn', '납부기한을 찾지 못했습니다.');
    }
    const future = new Date(); future.setFullYear(future.getFullYear() + 1);
    if (ex.issueDate && new Date(ex.issueDate) > future) push('issueDate', 'warn', '발행일이 1년 이상 미래입니다.');

    return out;
  }

  // 재촬영이 필요한지: 글자가 거의 없거나 OCR 신뢰도가 낮고 핵심 필드가 비어 있을 때
  function needsRetake(ex) {
    const len = (ex.rawText || '').replace(/\s/g, '').length;
    if (len < 15) return '문서에서 글자를 거의 찾지 못했습니다.';
    if ((ex.ocrConfidence ?? 1) < 0.45) return '사진이 흐리거나 어두워 인식 신뢰도가 낮습니다.';
    if (ex.totalAmount == null && !ex.businessNumber && !ex.vendorName) return '핵심 정보(상호·금액·사업자번호)를 하나도 찾지 못했습니다.';
    return null;
  }

  function fmt(n) { return n == null || n === '' ? '' : Number(n).toLocaleString('ko-KR'); }

  return { DOC_TYPES, parse, validate, needsRetake, checkBizNumber, toNumber, fmt, classify, similarity };
})();
