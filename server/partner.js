// 외부 연동 읽기 전용 API (/api/ext/v1) — HSO 등 다른 시스템이 업장별 청구·거래 자료를 가져간다.
// - 인증: 연동 시스템마다 발급한 API 키 (Authorization: Bearer chk_…)
// - 범위: 그 시스템에 매핑된 업장(= 상대의 지점 코드)의 문서만.
//         단, 키에 "전체 업장 허용"(all_workplaces)이 켜져 있으면 모든 업장 — 지점은 workplaceId로 구분
//         (지점 코드를 연결해 둔 업장은 branchCode도 함께 나간다)
// - 읽기 전용: GET만 있다. 이미지·OCR 원문·개인 식별 정보(고객명 등)는 내주지 않는다
// - 청구 확인 ≠ 납부 완료: paymentStatus는 항상 'unknown'. 실제 출금 내역과 합산하지 않도록 문서에 명시
// - 중복 등록된 사본은 기본으로 빼서 이중 합산을 막는다
const crypto = require('node:crypto');
const express = require('express');

const TYPE_LABELS = { giro: '지로', bill: '고지서', invoice: '거래명세서', tax_invoice: '세금계산서', auto: '미분류' };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isUuid = (s) => /^[0-9a-f-]{36}$/i.test(s || '');

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// 커서: 마지막 항목의 (updated_at, id) — 같은 시각에 바뀐 문서가 여럿이어도 빠짐없이 넘긴다.
// 시각은 DB의 마이크로초까지 그대로 쓴다 (JS Date는 밀리초로 잘라 같은 문서가 다시 나오게 된다)
const encodeCursor = (r) => Buffer.from(`${r.updated_at_us}|${r.id}`).toString('base64url');
function decodeCursor(s) {
  try {
    const [at, id] = Buffer.from(String(s), 'base64url').toString().split('|');
    if (!isUuid(id) || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(at)) throw new Error();
    return { at, id };
  } catch {
    throw new ApiError(400, 'invalid_cursor', 'cursor 값이 올바르지 않습니다');
  }
}
// 받은 시각 문자열은 검사만 하고 그대로 DB에 넘긴다 (마이크로초 보존)
const parseTime = (s, name) => {
  if (s == null || s === '') return null;
  const t = String(s).trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(t) || Number.isNaN(Date.parse(t))) {
    throw new ApiError(400, 'invalid_parameter', `${name}는 ISO 8601 시각이어야 합니다 (예: 2026-10-30T01:58:53.180123Z)`);
  }
  return t;
};
const US = (col) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function toDocument(r, withItems) {
  const out = {
    id: r.id,
    workplaceId: r.workplace_id, // 업장(지점) 고유 id — 바뀌지 않음. 지점 코드가 없을 때 지점 구분용
    branchCode: r.branch_code,   // 연결된 지점 코드 (전체 허용 키에서 연결 안 된 업장은 null)
    workplace: { code: r.workplace_code, hotelName: r.hotel_name, name: r.workplace_name }, // code: 업장코드
    documentType: r.document_type,
    documentTypeLabel: TYPE_LABELS[r.document_type] || r.document_type,
    reviewStatus: r.status === 'verified' ? 'confirmed' : 'unconfirmed', // 확인 / 미확인
    confirmedAt: r.status === 'verified' ? r.verified_at : null,
    confirmedBy: r.status === 'verified' ? (r.verified_by === 'auto' ? 'auto' : 'human') : null,
    needsRetake: r.status === 'needs_retake',
    vendorName: r.vendor_name,
    businessNumber: r.business_number,
    documentNumber: r.document_number,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    billingMonth: r.billing_month,
    totalAmount: r.total_amount,
    taxAmount: r.tax_amount,
    currency: 'KRW',
    paymentStatus: 'unknown', // 청구 자료일 뿐 납부·출금 여부는 이 시스템이 알지 못한다
    isDuplicate: r.duplicate_decision === 'duplicate',
    duplicateOf: r.duplicate_decision === 'duplicate' ? r.duplicate_of : null,
    itemCount: r.item_count ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at_us, // 마이크로초까지 (updatedSince에 그대로 넘기면 된다)
  };
  if (withItems) {
    out.lineItems = (r.items || []).map((it) => ({
      lineNo: it.line_no, itemName: it.item_name, unit: it.unit, quantity: it.quantity, unitPrice: it.unit_price, amount: it.amount,
    }));
  }
  return out;
}

const DOC_SELECT = `
  SELECT d.id, d.document_type, d.status, d.verified_by, d.verified_at, d.created_at, ${US('d.updated_at')} AS updated_at_us,
         d.duplicate_decision, d.duplicate_of, d.workplace_id,
         m.branch_code, w.hotel_name, w.name AS workplace_name, w.code AS workplace_code,
         e.vendor_name, e.business_number, e.document_number, e.issue_date, e.due_date, e.billing_month,
         e.total_amount, e.tax_amount,
         (SELECT count(*)::int FROM line_items l WHERE l.extracted_data_id = e.id) AS item_count
    FROM documents d
    LEFT JOIN api_client_workplaces m ON m.workplace_id = d.workplace_id AND m.client_id = $1
    JOIN workplaces w ON w.id = d.workplace_id
    LEFT JOIN extracted_data e ON e.document_id = d.id`;
// 이 키가 볼 수 있는 업장 조건 (m = 지점 연결). all_workplaces는 DB에서 읽은 값이라 SQL에 그대로 넣어도 안전
const scope = (client) => (client.all_workplaces ? 'TRUE' : 'm.client_id IS NOT NULL');

module.exports = function partnerRouter({ pool, onAudit }) {
  const r = express.Router();

  // 키 인증 + 호출 제한(키당 분당 300회)
  const hits = new Map();
  r.use(async (req, res, next) => {
    try {
      const m = /^Bearer\s+(chk_[A-Za-z0-9_-]{20,})$/.exec(req.headers.authorization || '');
      if (!m) throw new ApiError(401, 'unauthorized', 'Authorization: Bearer <API 키> 헤더가 필요합니다');
      const { rows: [client] } = await pool.query('SELECT id, name, active, all_workplaces FROM api_clients WHERE key_hash = $1', [sha256(m[1])]);
      if (!client || !client.active) throw new ApiError(401, 'unauthorized', 'API 키가 올바르지 않거나 중지되었습니다');
      const now = Date.now();
      const h = hits.get(client.id);
      if (!h || h.reset < now) hits.set(client.id, { n: 1, reset: now + 60_000 });
      else if (++h.n > 300) throw new ApiError(429, 'rate_limited', '호출이 너무 많습니다. 1분 뒤 다시 시도하세요');
      req.client = client;
      pool.query('UPDATE api_clients SET last_used_at = now() WHERE id = $1', [client.id]).catch(() => {});
      next();
    } catch (e) { next(e); }
  });
  r.use((req, res, next) => {
    if (req.method !== 'GET') return next(new ApiError(405, 'method_not_allowed', '읽기 전용 API입니다'));
    // 연동 호출도 접속기록에 남긴다 (어떤 시스템이 언제 무엇을 가져갔는지)
    res.on('finish', () => onAudit(req, res));
    next();
  });
  const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

  // 연결 확인 + 내게 매핑된 지점 목록
  r.get('/branches', wrap(async (req, res) => {
    res.locals.audit = { action: 'partner.branches' };
    const { rows } = await pool.query(
      `SELECT w.id, w.code, m.branch_code, w.hotel_name, w.name FROM workplaces w
         LEFT JOIN api_client_workplaces m ON m.workplace_id = w.id AND m.client_id = $1
        WHERE ${scope(req.client)} ORDER BY w.hotel_name, w.name`,
      [req.client.id],
    );
    res.json({
      client: req.client.name,
      scope: req.client.all_workplaces ? 'all' : 'mapped', // all: 모든 업장 / mapped: 연결한 지점만
      branches: rows.map((x) => ({ workplaceId: x.id, workplaceCode: x.code, branchCode: x.branch_code, hotelName: x.hotel_name, workplaceName: x.name })),
    });
  }));

  // 문서 목록 (증분 동기화): 변경 시각 오름차순 + 커서
  r.get('/documents', wrap(async (req, res) => {
    res.locals.audit = { action: 'partner.documents.list' };
    const q = req.query;
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 100));
    const params = [req.client.id];
    const where = [scope(req.client), `d.status <> 'processing'`]; // 인식 중인 문서는 아직 값이 없다
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (q.branch) add('m.branch_code = ?', String(q.branch));
    if (q.workplace) {
      if (!isUuid(q.workplace)) throw new ApiError(400, 'invalid_parameter', 'workplace는 업장 id(UUID)');
      add('d.workplace_id = ?', q.workplace);
    }
    if (q.status) {
      if (!['confirmed', 'unconfirmed'].includes(q.status)) throw new ApiError(400, 'invalid_parameter', 'status는 confirmed 또는 unconfirmed');
      where.push(q.status === 'confirmed' ? `d.status = 'verified'` : `d.status IN ('needs_review', 'needs_retake')`);
    }
    if (q.type) {
      const types = String(q.type).split(',');
      if (types.some((t) => !TYPE_LABELS[t])) throw new ApiError(400, 'invalid_parameter', 'type은 giro,bill,invoice,tax_invoice 중에서');
      add('d.document_type = ANY(?)', types);
    }
    if (q.includeDuplicates !== 'true') where.push(`d.duplicate_decision IS DISTINCT FROM 'duplicate'`);
    const since = parseTime(q.updatedSince, 'updatedSince');
    if (since) add('d.updated_at > ?', since);
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      params.push(c.at, c.id);
      where.push(`(d.updated_at, d.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit + 1);
    const { rows } = await pool.query(
      `${DOC_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.updated_at, d.id LIMIT $${params.length}`,
      params,
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    res.json({
      data: page.map((x) => toDocument(x, false)),
      hasMore,
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
      // 다음 증분 동기화 때 updatedSince로 쓸 값 (마지막 항목의 변경 시각)
      syncedUntil: page.length ? page[page.length - 1].updated_at_us : since,
    });
  }));

  // 문서 상세 (품목 포함)
  r.get('/documents/:id', wrap(async (req, res) => {
    res.locals.audit = { action: 'partner.documents.view', targetId: req.params.id };
    if (!isUuid(req.params.id)) throw new ApiError(404, 'not_found', '문서를 찾을 수 없습니다');
    const { rows: [doc] } = await pool.query(
      `${DOC_SELECT} WHERE ${scope(req.client)} AND d.id = $2 AND d.status <> 'processing'`, [req.client.id, req.params.id],
    );
    if (!doc) throw new ApiError(404, 'not_found', '문서를 찾을 수 없습니다');
    doc.items = (await pool.query(
      `SELECT l.* FROM line_items l JOIN extracted_data e ON e.id = l.extracted_data_id WHERE e.document_id = $1 ORDER BY l.line_no`,
      [doc.id],
    )).rows;
    res.json(toDocument(doc, true));
  }));

  // 삭제된 문서 (상대 시스템에서도 지우도록). 90일 보관
  r.get('/deleted-documents', wrap(async (req, res) => {
    res.locals.audit = { action: 'partner.deleted.list' };
    const since = parseTime(req.query.since, 'since');
    const params = [req.client.id];
    let sql = `SELECT x.document_id, x.workplace_id, ${US('x.deleted_at')} AS deleted_at, m.branch_code FROM document_deletions x
                 LEFT JOIN api_client_workplaces m ON m.workplace_id = x.workplace_id AND m.client_id = $1
                WHERE ${scope(req.client)}`;
    if (since) { params.push(since); sql += ` AND x.deleted_at > $2`; }
    const { rows } = await pool.query(`${sql} ORDER BY 3 LIMIT 1000`, params);
    res.json({ data: rows.map((x) => ({ id: x.document_id, workplaceId: x.workplace_id, branchCode: x.branch_code, deletedAt: x.deleted_at })) });
  }));

  r.use((req, res, next) => next(new ApiError(404, 'not_found', '없는 API입니다')));
  // 연동용 오류 형식: { error: { code, message } }
  r.use((err, req, res, next) => {
    if (err instanceof ApiError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    console.error(err);
    res.status(500).json({ error: { code: 'server_error', message: '서버 오류' } });
  });
  return r;
};

module.exports.sha256 = sha256;
