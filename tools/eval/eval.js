// 라벨링 데이터셋으로 인식 정확도를 필드별로 측정한다.
//   node eval.js --data <라벨폴더> [--data <라벨폴더> ...] [--engine paddle|tesseract] [--no-cache] [--verbose]
// 라벨폴더: labels/*.json (target 포함) + images/ 구조 (README의 라벨 규칙 참고)
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i < 0 ? def : args[i + 1]; };
const dataDirs = args.flatMap((a, i) => (a === '--data' ? [args[i + 1]] : []));
const ENGINE = opt('engine', 'paddle');
const USE_CACHE = !args.includes('--no-cache');
const VERBOSE = args.includes('--verbose');
// --memory: 앱의 "거래처 기억"을 흉내 낸다. 평가 문서와 같은 group_id(중복 사진·연속 페이지)를 뺀
// 나머지 문서의 정답 상호·고객명을 "이전에 검수 확정한 이름"으로 준다 (leave-one-group-out)
const MEMORY = args.includes('--memory');
const CACHE_DIR = path.join(__dirname, 'cache', ENGINE);
if (!dataDirs.length) {
  console.error('사용법: node eval.js --data <라벨폴더> [--data ...] [--engine paddle|tesseract]');
  process.exit(1);
}

// 앱과 같은 추출 코드를 그대로 불러온다 (브라우저용 전역 스크립트)
function loadBrowserScript(file, name) {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', file), 'utf8') + `\n;this.${name} = ${name};`, ctx);
  return ctx[name];
}
const Parser = loadBrowserScript('parser.js', 'Parser');

// ---------- 정답 → 앱 필드로 변환 ----------
function expectedFields(target) {
  const t = (target['문서들'] || [target])[0]; // 한 사진에 명세서가 둘이면 첫 번째만 평가 (앱도 한 장에 한 건)
  const isInvoice = !!t['공급자'] || /명세서/.test(t['문서유형'] || '') && t['합계금액'] !== undefined;
  return {
    type: isInvoice ? 'invoice' : 'bill',
    fields: {
      vendorName: isInvoice ? t['공급자']?.['상호'] ?? t['발행처'] : t['발행처'],
      businessNumber: isInvoice ? t['공급자']?.['사업자등록번호'] : undefined,
      customerName: t['고객명'],
      issueDate: t['발행일'],
      dueDate: t['납부기한'],
      billingMonth: t['청구년월'],
      totalAmount: isInvoice ? t['합계금액'] : t['납기내금액'] ?? t['당월부과액'],
      taxAmount: t['부가세'],
    },
    items: (t['항목'] || []).filter((it) => it['금액'] != null)
      .map((it) => ({ itemName: it['항목명'], quantity: it['수량'], unitPrice: it['단가'], amount: it['금액'] })),
  };
}

// ---------- 비교 ----------
const normText = (s) => String(s ?? '').replace(/\s+/g, '').replace(/㈜|\(주\)/g, '주식회사').replace(/[‐-―]/g, '-');
function similarity(a, b) {
  a = normText(a); b = normText(b);
  if (!a && !b) return 1;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}
function sameValue(field, exp, got) {
  if (got == null || got === '') return false;
  if (typeof exp === 'number') return Number(got) === exp;
  if (field === 'businessNumber') return String(got).replace(/\D/g, '') === String(exp).replace(/\D/g, '');
  return normText(got) === normText(exp);
}
function matchItems(exp, got) {
  const used = new Set();
  let tp = 0, nameSim = 0;
  for (const e of exp) {
    let best = -1, bs = -1;
    got.forEach((g, i) => {
      if (used.has(i) || Number(g.amount) !== e.amount) return;
      const s = similarity(e.itemName, g.itemName);
      if (s > bs) { bs = s; best = i; }
    });
    if (best >= 0) { used.add(best); tp++; nameSim += bs; }
  }
  return { tp, exp: exp.length, got: got.length, nameSim };
}

// ---------- OCR 엔진 ----------
async function loadImage(file) {
  const { data, info } = await sharp(file).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function makeEngine() {
  if (ENGINE === 'paddle') {
    const ort = require('onnxruntime-node');
    const PaddleOCR = require(path.join(ROOT, 'js', 'paddle.js'));
    const ocr = await PaddleOCR.create({
      ort,
      detModel: path.join(ROOT, 'models', 'det.onnx'),
      recModel: path.join(ROOT, 'models', 'rec_korean.onnx'),
      dictText: fs.readFileSync(path.join(ROOT, 'models', 'dict_korean.txt'), 'utf8'),
    });
    return { run: async (file) => ocr.run(await loadImage(file)), close: async () => {} };
  }
  if (ENGINE === 'tesseract') {
    // 앱의 기존 방식과 같게: 회색조 + 대비 늘이기 + 최대 2배 확대
    const { createWorker } = require('tesseract.js');
    const worker = await createWorker('kor+eng', 1);
    return {
      run: async (file) => {
        const meta = await sharp(file).metadata();
        const s = Math.min(2, 2000 / meta.width);
        const png = await sharp(file).rotate().resize(Math.round(meta.width * s)).grayscale().normalize().png().toBuffer();
        const { data } = await worker.recognize(png);
        return {
          text: data.text, confidence: data.confidence,
          lines: (data.lines || []).map((l) => ({ text: l.text.trim(), confidence: l.confidence,
            box: [l.bbox.x0, l.bbox.y0, l.bbox.x1, l.bbox.y1].map((v) => Math.round(v / s)) })),
        };
      },
      close: () => worker.terminate(),
    };
  }
  throw new Error('알 수 없는 엔진: ' + ENGINE);
}

// ---------- 실행 ----------
(async () => {
  const docs = [];
  for (const dir of dataDirs) {
    for (const f of fs.readdirSync(path.join(dir, 'labels')).filter((x) => x.endsWith('.json')).sort()) {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'labels', f), 'utf8'));
      docs.push({ ...j, file: path.join(dir, 'images', j.image) });
    }
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  let engine;

  const FIELDS = ['vendorName', 'businessNumber', 'customerName', 'issueDate', 'dueDate', 'billingMonth', 'totalAmount', 'taxAmount'];
  const stats = {}; // stats[type][field] = { n, ok, sim, fp }
  const itemStats = {};
  const results = [];
  const t0 = Date.now();

  for (const doc of docs) {
    const cacheFile = path.join(CACHE_DIR, doc.id + '.json');
    let ocr;
    if (USE_CACHE && fs.existsSync(cacheFile)) ocr = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    else {
      engine = engine || await makeEngine();
      const t = Date.now();
      ocr = await engine.run(doc.file);
      ocr.ms = Date.now() - t;
      fs.writeFileSync(cacheFile, JSON.stringify(ocr));
    }
    const exp = expectedFields(doc.target);
    const typeHint = exp.type === 'invoice' ? 'invoice' : 'auto';
    let memory = {};
    if (MEMORY) {
      const others = docs.filter((o) => o.group_id !== doc.group_id && o.id !== doc.id && o.id !== doc.duplicate_of && o.duplicate_of !== doc.id)
        .map((o) => expectedFields(o.target).fields);
      const uniq = (a) => [...new Set(a.filter(Boolean))];
      memory = { vendors: uniq(others.map((f) => f.vendorName)), customers: uniq(others.map((f) => f.customerName)) };
    }
    const parsed = Parser.parse(ocr, typeHint, memory);
    const got = parsed.data;

    const st = stats[exp.type] = stats[exp.type] || {};
    const row = { id: doc.id, type: exp.type, ms: ocr.ms, fields: {} };
    for (const f of FIELDS) {
      const e = exp.fields[f];
      const s = st[f] = st[f] || { n: 0, ok: 0, sim: 0, fp: 0 };
      if (e == null) { if (got[f] != null && got[f] !== '') s.fp++; continue; }
      s.n++;
      const ok = sameValue(f, e, got[f]);
      if (ok) s.ok++;
      s.sim += typeof e === 'number' ? (ok ? 1 : 0) : similarity(e, got[f]);
      row.fields[f] = { exp: e, got: got[f] ?? null, ok };
    }
    const m = matchItems(exp.items, parsed.lineItems);
    const is = itemStats[exp.type] = itemStats[exp.type] || { tp: 0, exp: 0, got: 0, nameSim: 0 };
    is.tp += m.tp; is.exp += m.exp; is.got += m.got; is.nameSim += m.nameSim;
    row.items = m;
    results.push(row);

    if (VERBOSE) {
      console.log(`\n${doc.id} [${exp.type}] ${ocr.ms ? ocr.ms + 'ms' : '(캐시)'}`);
      for (const [f, r] of Object.entries(row.fields)) console.log(`  ${r.ok ? '✓' : '✗'} ${f}: 정답=${r.exp} | 인식=${r.got}`);
      console.log(`  품목 ${m.tp}/${m.exp} 일치 (인식 ${m.got}개)`);
    }
  }
  if (engine) await engine.close();

  // ---------- 요약 ----------
  const pct = (a, b) => (b ? ((a / b) * 100).toFixed(0) + '%' : '-');
  console.log(`\n=== 엔진: ${ENGINE}${MEMORY ? ' + 거래처 기억' : ''} | 문서 ${docs.length}장 | ${((Date.now() - t0) / 1000).toFixed(1)}초 ===`);
  let allOk = 0, allN = 0;
  for (const [type, st] of Object.entries(stats)) {
    console.log(`\n[${type === 'invoice' ? '거래명세서' : '고지서'}]  필드              정확도   (맞음/정답있음)  글자유사도  오탐`);
    for (const f of FIELDS) {
      const s = st[f];
      if (!s || !s.n) continue;
      allOk += s.ok; allN += s.n;
      console.log(`  ${f.padEnd(16)}  ${pct(s.ok, s.n).padStart(6)}   (${s.ok}/${s.n})`.padEnd(48) + `${pct(s.sim, s.n).padStart(6)}     ${s.fp}`);
    }
    const it = itemStats[type];
    if (it.exp) {
      const p = it.got ? it.tp / it.got : 0, r = it.tp / it.exp;
      console.log(`  ${'lineItems'.padEnd(16)}  재현율 ${pct(it.tp, it.exp)} · 정밀도 ${pct(it.tp, it.got)} · F1 ${p + r ? ((2 * p * r) / (p + r) * 100).toFixed(0) : 0}% · 품목명 유사도 ${pct(it.nameSim, it.tp)}`);
    }
  }
  console.log(`\n전체 필드 정확도: ${pct(allOk, allN)} (${allOk}/${allN})`);
  const outFile = path.join(__dirname, 'results', `${ENGINE}${MEMORY ? '-memory' : ''}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`문서별 상세: ${path.relative(process.cwd(), outFile)}`);
})().catch((e) => { console.error(e); process.exit(1); });
