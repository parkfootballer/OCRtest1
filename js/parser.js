// OCR 텍스트 → ExtractedData / LineItem 변환, 그리고 대조(검증) 규칙.
const Parser = (() => {
  const DOC_TYPES = {
    auto: '자동 판별',
    giro: '지로',
    bill: '고지서',
    invoice: '거래명세서',
    tax_invoice: '세금계산서',
  };

  const KW = {
    vendor: ['상호', '상호명', '업체명', '회사명', '법인명', '공급자', '수납기관', '청구기관', '발행처'],
    issue: ['작성일자', '작성일', '발행일', '거래일자', '거래일', '청구일', '고지일', '일자'],
    due: ['납부기한', '납기일', '납기', '납부마감', '마감일', '지불기한', '기한'],
    total: ['합계금액', '총합계', '청구금액', '납부금액', '납부할금액', '총금액', '총액', '합계'],
    tax: ['부가가치세', '부가세', '세액', 'VAT'],
    supply: ['공급가액', '공급가'],
  };

  // "합계금액" → /합\s*계\s*금\s*액/ : 한글 OCR이 글자 사이에 공백을 넣는 경우를 흡수
  const kwRegex = (kw) => new RegExp(kw.split('').map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'i');

  const BIZ_RE = /(\d{3})\s*[-–]\s*(\d{2})\s*[-–]\s*(\d{5})/g;
  const DATE_RE = /(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?/g;
  const AMOUNT_RE = /\d{1,3}(?:\s?[,.]\s?\d{3})+|\d{3,}/g;

  function classify(text) {
    const t = text.replace(/\s/g, '');
    if (/세금계산서/.test(t)) return 'tax_invoice';
    if (/거래명세/.test(t)) return 'invoice';
    if (/지로/.test(t)) return 'giro';
    if (/고지서|고지|납부서|청구서/.test(t)) return 'bill';
    return 'invoice';
  }

  function toNumber(s) {
    if (s == null) return null;
    const n = parseInt(String(s).replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function datesIn(s) {
    const out = [];
    for (const m of s.matchAll(DATE_RE)) {
      const y = +m[1], mo = +m[2], d = +m[3];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.push(`${y}-${pad(mo)}-${pad(d)}`);
    }
    return out;
  }

  // 날짜·사업자번호를 지운 뒤 금액 후보만 뽑는다
  function amountsIn(s) {
    const cleaned = s.replace(BIZ_RE, ' ').replace(DATE_RE, ' ');
    return [...cleaned.matchAll(AMOUNT_RE)].map((m) => toNumber(m[0])).filter((n) => n != null);
  }

  function afterKeyword(line, keywords) {
    for (const kw of keywords) {
      const m = line.match(kwRegex(kw));
      if (m) return { kw, rest: line.slice(m.index + m[0].length) };
    }
    return null;
  }

  // 키워드가 있는 줄(값이 없으면 다음 줄)에서 pick()으로 값을 찾는다
  function findByKeyword(lines, keywords, pick, exclude) {
    for (let i = 0; i < lines.length; i++) {
      const hit = afterKeyword(lines[i].text, keywords);
      if (!hit) continue;
      if (exclude && exclude.test(lines[i].text.replace(/\s/g, ''))) continue;
      let v = pick(hit.rest);
      if (v != null) return { value: v, conf: lines[i].conf };
      if (lines[i + 1]) {
        v = pick(lines[i + 1].text);
        if (v != null) return { value: v, conf: Math.min(lines[i].conf, lines[i + 1].conf) * 0.9 };
      }
    }
    return null;
  }

  function checkBizNumber(num) {
    const d = String(num || '').replace(/\D/g, '').split('').map(Number);
    if (d.length !== 10) return false;
    const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
    let sum = w.reduce((s, wi, i) => s + wi * d[i], 0);
    sum += Math.floor((d[8] * 5) / 10);
    return (10 - (sum % 10)) % 10 === d[9];
  }

  function cleanVendor(s) {
    return s
      .replace(/^[\s:：|\][)]+/, '')
      .split(/\s{2,}|성\s*명|대\s*표|등\s*록|사\s*업\s*장|주\s*소|\|/)[0]
      .replace(/[^\p{L}\p{N}()㈜&.\s-]/gu, '')
      .trim();
  }

  function extractLineItems(lines) {
    const items = [];
    const stop = /합계|총액|소계|공급가액|세액|부가세|청구금액|납부금액/;
    for (const { text, conf } of lines) {
      if (stop.test(text.replace(/\s/g, ''))) continue;
      const tokens = [...text.matchAll(/\d{1,3}(?:,\d{3})+|\d+/g)];
      for (let i = 0; i + 2 < tokens.length; i++) {
        const [q, u, a] = [0, 1, 2].map((k) => toNumber(tokens[i + k][0]));
        if (!q || !u || !a || q > 100000) continue;
        if (Math.abs(q * u - a) > 1) continue;
        const name = text.slice(0, tokens[i].index)
          .replace(/^\s*\d+[.)]?\s+/, '')
          .replace(/[|:]/g, ' ')
          .trim();
        if (!name || !/[\p{L}]/u.test(name)) break;
        items.push({ itemName: name, quantity: q, unitPrice: u, amount: a, _conf: conf / 100 });
        break;
      }
    }
    return items;
  }

  /**
   * @param ocr {text, confidence, lines:[{text, confidence}]}
   * @param typeHint 사용자가 고른 문서 종류 ('auto' 가능)
   */
  function parse(ocr, typeHint = 'auto') {
    const rawText = (ocr.text || '').trim();
    const lines = (ocr.lines && ocr.lines.length
      ? ocr.lines.map((l) => ({ text: l.text.trim(), conf: l.confidence }))
      : rawText.split('\n').map((t) => ({ text: t.trim(), conf: ocr.confidence || 0 }))
    ).filter((l) => l.text);

    const documentType = typeHint === 'auto' ? classify(rawText) : typeHint;
    const fc = {}; // 필드별 신뢰도 0~1

    // 사업자등록번호: 체크섬이 맞는 첫 번호 우선(거래명세서의 공급자가 보통 먼저 나옴)
    let businessNumber = null;
    for (const l of lines) {
      for (const m of l.text.matchAll(BIZ_RE)) {
        const n = `${m[1]}-${m[2]}-${m[3]}`;
        if (!businessNumber || (checkBizNumber(n) && !checkBizNumber(businessNumber))) {
          businessNumber = n; fc.businessNumber = l.conf / 100;
        }
      }
      if (businessNumber && checkBizNumber(businessNumber)) break;
    }

    let vendorName = null;
    const v = findByKeyword(lines, KW.vendor, (s) => { const c = cleanVendor(s); return c.length >= 2 ? c : null; });
    if (v) { vendorName = v.value; fc.vendorName = v.conf / 100; }
    else {
      const l = lines.find((x) => /\(주\)|㈜|주식회사|\(유\)/.test(x.text));
      if (l) { vendorName = cleanVendor(l.text); fc.vendorName = (l.conf / 100) * 0.7; }
    }

    const firstDate = (s) => datesIn(s)[0] ?? null;
    let issueDate = null, dueDate = null;
    const due = findByKeyword(lines, KW.due, firstDate);
    if (due) { dueDate = due.value; fc.dueDate = due.conf / 100; }
    const iss = findByKeyword(lines, KW.issue, firstDate, /납부기한|납기|기한/);
    if (iss) { issueDate = iss.value; fc.issueDate = iss.conf / 100; }
    if (!issueDate) {
      const all = lines.flatMap((l) => datesIn(l.text).map((d) => ({ d, conf: l.conf }))).filter((x) => x.d !== dueDate);
      if (all.length) { issueDate = all[0].d; fc.issueDate = (all[0].conf / 100) * 0.6; }
    }

    const maxAmount = (s) => { const a = amountsIn(s); return a.length ? Math.max(...a) : null; };
    let totalAmount = null, taxAmount = null, supplyAmount = null;
    const tableHeader = /품목|품명|단가|수량|규격/; // 표 머리글의 "세액"·"합계"는 값이 아님
    const tot = findByKeyword(lines, KW.total, maxAmount, tableHeader);
    if (tot) { totalAmount = tot.value; fc.totalAmount = tot.conf / 100; }
    const tax = findByKeyword(lines, KW.tax, (s) => amountsIn(s)[0] ?? null, tableHeader);
    if (tax) { taxAmount = tax.value; fc.taxAmount = tax.conf / 100; }
    const sup = findByKeyword(lines, KW.supply, (s) => amountsIn(s)[0] ?? null, tableHeader);
    if (sup) supplyAmount = sup.value;

    // 합계 키워드가 없으면 공급가액+세액, 그래도 없으면 가장 큰 금액
    if (totalAmount == null && supplyAmount != null && taxAmount != null) {
      totalAmount = supplyAmount + taxAmount; fc.totalAmount = 0.6;
    }
    if (totalAmount == null) {
      const all = lines.flatMap((l) => amountsIn(l.text).map((a) => ({ a, conf: l.conf })));
      if (all.length) {
        const best = all.reduce((m, x) => (x.a > m.a ? x : m));
        totalAmount = best.a; fc.totalAmount = (best.conf / 100) * 0.4;
      }
    }

    const lineItems = extractLineItems(lines);

    const ocrConf = (ocr.confidence || 0) / 100;
    const keyFields = ['vendorName', 'businessNumber', 'issueDate', 'totalAmount'];
    if (documentType === 'giro' || documentType === 'bill') keyFields.push('dueDate');
    const coverage = keyFields.reduce((s, f) => s + (fc[f] || 0), 0) / keyFields.length;
    const confidenceScore = Math.round((ocrConf * 0.4 + coverage * 0.6) * 100) / 100;

    return {
      documentType,
      data: {
        vendorName, businessNumber, issueDate, dueDate, totalAmount, taxAmount,
        rawText, confidenceScore, fieldConfidence: fc, ocrConfidence: ocrConf,
      },
      lineItems: lineItems.map(({ _conf, ...it }) => it),
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
      const bad = items.filter((it) => Math.abs(it.quantity * it.unitPrice - it.amount) > 1);
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

  return { DOC_TYPES, parse, validate, needsRetake, checkBizNumber, toNumber, fmt, classify };
})();
