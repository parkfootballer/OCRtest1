// 중복 문서 감지: 같은 파일인지(해시), 그리고 공급업체·문서번호·작성일·총액이 얼마나 겹치는지로 판단한다.
//   exact    — 같은 파일이거나, 핵심 정보가 모두 일치 (공급업체+문서번호, 또는 공급업체+작성일+총액)
//   possible — 핵심 정보 중 2개 이상 일치하고 서로 어긋나는 정보(다른 날짜·다른 문서번호)가 없음

const normName = (s) => String(s || '').toLowerCase()
  .replace(/주식회사|\(주\)|㈜|\(유\)|유한회사/g, '')
  .replace(/[\s()[\]{}.,·'"\-_/&]/g, '');
const normDocNo = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const digits = (s) => String(s || '').replace(/\D/g, '');

// 편집거리 기반 유사도 0~1 (OCR 오타 한두 글자는 같은 업체로 본다)
function similarity(a, b) {
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

// a, b: { fileHash, vendorName, businessNumber, documentNumber, issueDate, billingMonth, totalAmount }
function compare(a, b) {
  if (a.fileHash && a.fileHash === b.fileHash) return { level: 'exact', reasons: ['같은 파일'] };

  const bizA = digits(a.businessNumber), bizB = digits(b.businessNumber);
  const nA = normName(a.vendorName), nB = normName(b.vendorName);
  const vendor = (bizA.length === 10 && bizA === bizB) || (nA && nB && (nA === nB || similarity(nA, nB) >= 0.85));
  const dA = normDocNo(a.documentNumber), dB = normDocNo(b.documentNumber);
  const docNo = !!dA && dA === dB;
  const docNoConflict = !!dA && !!dB && dA !== dB;
  // 작성일이 없으면(고지서) 청구년월로 비교
  const [dateA, dateB] = a.issueDate && b.issueDate ? [a.issueDate, b.issueDate] : [a.billingMonth, b.billingMonth];
  const date = !!dateA && dateA === dateB;
  const dateConflict = !!dateA && !!dateB && dateA !== dateB;
  const total = a.totalAmount != null && b.totalAmount != null && Number(a.totalAmount) === Number(b.totalAmount);

  const reasons = [];
  if (vendor) reasons.push('공급업체 일치');
  if (docNo) reasons.push('문서번호 일치');
  if (date) reasons.push(a.issueDate && b.issueDate ? '작성일 일치' : '청구년월 일치');
  if (total) reasons.push('총액 일치');

  if (docNoConflict) return null; // 문서번호가 다르면 다른 문서
  if (vendor && docNo) return { level: 'exact', reasons };
  if (vendor && date && total) return { level: 'exact', reasons };
  if (dateConflict && !docNo) return null; // 같은 업체·같은 금액이라도 다른 달이면 정기 청구
  if (reasons.length >= 2) return { level: 'possible', reasons };
  return null;
}

const CANDIDATE_SQL = `
  SELECT d.id, d.document_type, d.status, d.created_at, d.file_hash, d.image_url, d.inventory_status, d.duplicate_of,
         e.vendor_name, e.business_number, e.document_number, e.issue_date, e.billing_month, e.total_amount
    FROM documents d LEFT JOIN extracted_data e ON e.document_id = d.id
   WHERE d.workplace_id = $1 AND d.id IS DISTINCT FROM $2
     -- 이미 "중복으로 등록"된 사본은 후보에서 뺀다 (그 원본이 대신 비교되고, 원본을 검수할 때 자기 사본이 걸리지 않게)
     AND d.duplicate_decision IS DISTINCT FROM 'duplicate'
     AND ( (d.file_hash IS NOT NULL AND d.file_hash = $3)
        OR (e.total_amount IS NOT NULL AND e.total_amount = $4)
        OR (e.document_number IS NOT NULL AND e.document_number = $5)
        OR (e.issue_date IS NOT NULL AND e.issue_date = $6)
        OR (e.business_number IS NOT NULL AND e.business_number = $7) )
   ORDER BY d.created_at DESC
   LIMIT 300`;

const rowKeys = (r) => ({
  fileHash: r.file_hash, vendorName: r.vendor_name, businessNumber: r.business_number,
  documentNumber: r.document_number, issueDate: r.issue_date, billingMonth: r.billing_month, totalAmount: r.total_amount,
});

/**
 * 업장 안에서 중복 후보를 찾는다.
 * @param target { docId } 저장된 문서 기준, 또는 { fileHash } 업로드 전 파일 기준
 */
async function findDuplicates(c, workplaceId, target) {
  let keys = { fileHash: target.fileHash || null };
  if (target.docId) {
    const { rows } = await c.query(
      `SELECT d.file_hash, e.* FROM documents d LEFT JOIN extracted_data e ON e.document_id = d.id WHERE d.id = $1`,
      [target.docId],
    );
    if (rows[0]) keys = rowKeys(rows[0]);
  }
  const { rows } = await c.query(CANDIDATE_SQL, [
    workplaceId, target.docId || null, keys.fileHash || null, keys.totalAmount ?? null,
    keys.documentNumber || null, keys.issueDate || null, keys.businessNumber || null,
  ]);
  const out = [];
  for (const r of rows) {
    const m = compare(keys, rowKeys(r));
    if (!m) continue;
    out.push({
      ...m,
      document: {
        id: r.id, documentType: r.document_type, status: r.status, createdAt: r.created_at, imageUrl: r.image_url,
        inventoryStatus: r.inventory_status, duplicateOf: r.duplicate_of,
        vendorName: r.vendor_name, documentNumber: r.document_number, issueDate: r.issue_date,
        billingMonth: r.billing_month, totalAmount: r.total_amount,
      },
    });
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'exact' ? -1 : 1)).slice(0, 5);
}

module.exports = { findDuplicates, compare, normName };
