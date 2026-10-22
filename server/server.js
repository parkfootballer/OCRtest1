// 찰칵장부 API 서버: Express + PostgreSQL. 프런트엔드(PWA) 정적 파일도 함께 서빙한다.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const express = require('express');
const { Pool, types } = require('pg');

// DATE는 'YYYY-MM-DD' 문자열, BIGINT·NUMERIC은 숫자로 받는다
types.setTypeParser(1082, (v) => v);
types.setTypeParser(20, (v) => (v == null ? null : Number(v)));
types.setTypeParser(1700, (v) => (v == null ? null : Number(v)));

const PORT = Number(process.env.PORT || 8080);
const ROOT = path.resolve(process.env.STATIC_ROOT || path.join(__dirname, '..'));
const SIGNUP_CODE = process.env.SIGNUP_CODE || ''; // 설정하면 가입 시 이 초대 코드가 필요
const SESSION_DAYS = 30;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // 외부에서 클라우드 DB에 붙을 때만 SSL (Render 내부 주소는 SSL 불필요)
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

const STATUSES = ['processing', 'needs_retake', 'needs_review', 'verified'];
const DOC_TYPES = ['auto', 'giro', 'bill', 'invoice', 'tax_invoice'];

// ---------- 행 → API(camelCase) 변환 ----------
const toUser = (r) => r && { id: r.id, email: r.email, name: r.name, createdAt: r.created_at };
const toDoc = (r) => r && {
  id: r.id, userId: r.user_id, documentType: r.document_type, imageUrl: r.image_url, status: r.status,
  retakeReason: r.retake_reason, verifiedBy: r.verified_by, verifiedAt: r.verified_at, createdAt: r.created_at,
};
const toEx = (r) => r && {
  id: r.id, documentId: r.document_id, vendorName: r.vendor_name, businessNumber: r.business_number,
  issueDate: r.issue_date, dueDate: r.due_date, totalAmount: r.total_amount, taxAmount: r.tax_amount,
  rawText: r.raw_text, confidenceScore: r.confidence_score, fieldConfidence: r.field_confidence,
  ocrConfidence: r.ocr_confidence, qualityIssues: r.quality_issues,
};
const toItem = (r) => ({
  id: r.id, extractedDataId: r.extracted_data_id, lineNo: r.line_no, itemName: r.item_name,
  quantity: r.quantity, unitPrice: r.unit_price, amount: r.amount,
});
const toLog = (r) => ({
  id: r.id, documentId: r.document_id, reviewerId: r.reviewer_id, fieldName: r.field_name,
  originalValue: r.original_value, correctedValue: r.corrected_value, reviewedAt: r.reviewed_at,
});

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const isUuid = (s) => /^[0-9a-f-]{36}$/i.test(s);

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ---------- 인증 ----------
const scrypt = promisify(crypto.scrypt);
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
async function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const got = await scrypt(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function setSessionCookie(req, res, token, maxAgeSec) {
  const attrs = [`sid=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (req.secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), userId, SESSION_DAYS],
  );
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}

async function loadUser(req, res, next) {
  const token = readCookie(req, 'sid');
  if (token) {
    const { rows } = await pool.query(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)],
    );
    req.user = toUser(rows[0]) || null;
  }
  next();
}
function requireUser(req, res, next) {
  if (!req.user) return next(new HttpError(401, '로그인이 필요합니다'));
  next();
}

// 로그인 시도 제한: IP당 15분에 20회
const attempts = new Map();
function rateLimit(req) {
  const key = req.ip;
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.reset < now) return attempts.set(key, { n: 1, reset: now + 15 * 60_000 });
  if (++a.n > 20) throw new HttpError(429, '시도가 너무 많습니다. 잠시 후 다시 시도하세요');
}

// ---------- 이미지 (DB 저장) ----------
function decodeImage(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(dataUrl || '');
  if (!m) throw new HttpError(400, 'image는 data:image/...;base64 형식이어야 합니다');
  return { mime: m[1], data: Buffer.from(m[2], 'base64') };
}
async function storeImage(client, documentId, dataUrl) {
  const { mime, data } = decodeImage(dataUrl);
  const { rows } = await client.query(
    'INSERT INTO images (document_id, mime, data) VALUES ($1, $2, $3) RETURNING id',
    [documentId, mime, data],
  );
  return `/api/images/${rows[0].id}`;
}

// ---------- 문서 ----------
async function getOwnedDoc(client, id, userId) {
  if (!isUuid(id)) throw new HttpError(404, '문서를 찾을 수 없습니다');
  const { rows } = await client.query('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!rows[0]) throw new HttpError(404, '문서를 찾을 수 없습니다');
  return rows[0];
}

async function bundle(id, userId) {
  const doc = await getOwnedDoc(pool, id, userId);
  const ex = (await pool.query('SELECT * FROM extracted_data WHERE document_id = $1', [id])).rows[0];
  const items = ex
    ? (await pool.query('SELECT * FROM line_items WHERE extracted_data_id = $1 ORDER BY line_no', [ex.id])).rows
    : [];
  const logs = (await pool.query('SELECT * FROM review_logs WHERE document_id = $1 ORDER BY reviewed_at DESC', [id])).rows;
  return { doc: toDoc(doc), ex: toEx(ex), items: items.map(toItem), logs: logs.map(toLog) };
}

// ---------- 앱 ----------
const app = express();
app.set('trust proxy', 1); // Render 등 HTTPS 프록시 뒤에서 req.secure·req.ip가 맞게 나오도록
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '20mb' }));

// 다른 사이트에서 보낸 변경 요청 차단 (쿠키 인증 CSRF 방어)
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return next(new HttpError(403, '허용되지 않은 요청입니다'));
  next();
});

app.get('/api/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

app.use('/api', wrap(loadUser));

app.post('/api/auth/signup', wrap(async (req, res) => {
  rateLimit(req);
  const { email, name, password, code } = req.body || {};
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new HttpError(400, '이메일 형식이 올바르지 않습니다');
  if (!name || !String(name).trim()) throw new HttpError(400, '이름을 입력하세요');
  if (String(password || '').length < 8) throw new HttpError(400, '비밀번호는 8자 이상이어야 합니다');
  if (SIGNUP_CODE && code !== SIGNUP_CODE) throw new HttpError(403, '초대 코드가 올바르지 않습니다');
  const { rows } = await pool.query(
    `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING RETURNING *`,
    [mail, String(name).trim(), await hashPassword(password)],
  );
  if (!rows[0]) throw new HttpError(409, '이미 가입된 이메일입니다');
  await startSession(req, res, rows[0].id);
  res.status(201).json(toUser(rows[0]));
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  rateLimit(req);
  const mail = String(req.body?.email || '').trim().toLowerCase();
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [mail]);
  if (!rows[0] || !(await verifyPassword(String(req.body?.password || ''), rows[0].password_hash))) {
    throw new HttpError(401, '이메일 또는 비밀번호가 맞지 않습니다');
  }
  await startSession(req, res, rows[0].id);
  res.json(toUser(rows[0]));
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  const token = readCookie(req, 'sid');
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  setSessionCookie(req, res, '', 0);
  res.status(204).end();
}));

app.get('/api/auth/config', (req, res) => res.json({ signupCodeRequired: !!SIGNUP_CODE }));

// 이하 모든 API는 로그인 필요
app.use('/api', requireUser);

app.get('/api/me', (req, res) => res.json(req.user));

app.get('/api/images/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, '이미지가 없습니다');
  const { rows } = await pool.query(
    `SELECT i.mime, i.data FROM images i JOIN documents d ON d.id = i.document_id
      WHERE i.id = $1 AND d.user_id = $2`,
    [req.params.id, req.user.id],
  );
  if (!rows[0]) throw new HttpError(404, '이미지가 없습니다');
  res.setHeader('Content-Type', rows[0].mime);
  res.setHeader('Cache-Control', 'private, max-age=604800, immutable'); // 이미지 id는 내용이 바뀌지 않음
  res.end(rows[0].data);
}));

// 문서 목록 (+ 추출 요약)
app.get('/api/documents', wrap(async (req, res) => {
  const params = [req.user.id];
  let where = 'd.user_id = $1';
  if (req.query.status) {
    const list = String(req.query.status).split(',').filter((s) => STATUSES.includes(s));
    params.push(list);
    where += ` AND d.status = ANY($${params.length})`;
  }
  const { rows } = await pool.query(
    `SELECT d.*, CASE WHEN e.id IS NULL THEN NULL ELSE row_to_json(e) END AS ex
       FROM documents d LEFT JOIN extracted_data e ON e.document_id = d.id
      WHERE ${where}
      ORDER BY d.created_at DESC`,
    params,
  );
  res.json(rows.map((r) => ({ doc: toDoc(r), ex: toEx(r.ex) })));
}));

// 문서 생성 (촬영 이미지 업로드)
app.post('/api/documents', wrap(async (req, res) => {
  const { documentType = 'auto', image } = req.body || {};
  if (!DOC_TYPES.includes(documentType)) throw new HttpError(400, '알 수 없는 documentType');
  decodeImage(image); // 형식 오류를 트랜잭션 전에 걸러낸다
  const doc = await withTx(async (c) => {
    const { rows } = await c.query(
      'INSERT INTO documents (user_id, document_type) VALUES ($1, $2) RETURNING *',
      [req.user.id, documentType],
    );
    const url = await storeImage(c, rows[0].id, image);
    return (await c.query('UPDATE documents SET image_url = $1 WHERE id = $2 RETURNING *', [url, rows[0].id])).rows[0];
  });
  res.status(201).json(toDoc(doc));
}));

app.get('/api/documents/:id', wrap(async (req, res) => {
  res.json(await bundle(req.params.id, req.user.id));
}));

// 상태·종류 변경, 재촬영 시 이미지 교체
app.patch('/api/documents/:id', wrap(async (req, res) => {
  const b = req.body || {};
  const doc = await withTx(async (c) => {
    const old = await getOwnedDoc(c, req.params.id, req.user.id);
    const sets = [];
    const vals = [];
    const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) throw new HttpError(400, '알 수 없는 status');
      set('status', b.status);
    }
    if (b.documentType !== undefined) {
      if (!DOC_TYPES.includes(b.documentType)) throw new HttpError(400, '알 수 없는 documentType');
      set('document_type', b.documentType);
    }
    if (b.retakeReason !== undefined) set('retake_reason', b.retakeReason);
    if (b.verifiedBy !== undefined) set('verified_by', b.verifiedBy);
    if (b.verifiedAt !== undefined) set('verified_at', b.verifiedAt);
    if (b.image !== undefined) {
      const url = await storeImage(c, old.id, b.image);
      await c.query('DELETE FROM images WHERE document_id = $1 AND id <> $2', [old.id, url.split('/').pop()]);
      set('image_url', url);
    }
    if (!sets.length) return old;
    vals.push(old.id);
    return (await c.query(`UPDATE documents SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals)).rows[0];
  });
  res.json(toDoc(doc));
}));

// 추출 결과 저장 — 기존 추출/품목을 트랜잭션으로 통째로 교체
app.put('/api/documents/:id/extraction', wrap(async (req, res) => {
  const { data = {}, items = [] } = req.body || {};
  const id = req.params.id;
  await withTx(async (c) => {
    await getOwnedDoc(c, id, req.user.id);
    await c.query('DELETE FROM extracted_data WHERE document_id = $1', [id]);
    const { rows } = await c.query(
      `INSERT INTO extracted_data (document_id, vendor_name, business_number, issue_date, due_date,
         total_amount, tax_amount, raw_text, confidence_score, field_confidence, ocr_confidence, quality_issues)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [id, data.vendorName || null, data.businessNumber || null, data.issueDate || null, data.dueDate || null,
        data.totalAmount ?? null, data.taxAmount ?? null, data.rawText || '', data.confidenceScore ?? null,
        JSON.stringify(data.fieldConfidence || {}), data.ocrConfidence ?? null, JSON.stringify(data.qualityIssues || [])],
    );
    for (const [i, it] of items.entries()) {
      await c.query(
        `INSERT INTO line_items (extracted_data_id, line_no, item_name, quantity, unit_price, amount)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [rows[0].id, i + 1, it.itemName || '', it.quantity ?? null, it.unitPrice ?? null, it.amount ?? null],
      );
    }
  });
  res.json(await bundle(id, req.user.id));
}));

// 검수 기록 추가 (여러 건 한 번에)
app.post('/api/documents/:id/review-logs', wrap(async (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [req.body];
  const id = req.params.id;
  const out = await withTx(async (c) => {
    await getOwnedDoc(c, id, req.user.id);
    const saved = [];
    for (const e of entries) {
      if (!e?.fieldName) throw new HttpError(400, 'fieldName이 필요합니다');
      const { rows } = await c.query(
        `INSERT INTO review_logs (document_id, reviewer_id, field_name, original_value, corrected_value)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [id, req.user.id, e.fieldName, e.originalValue == null ? '' : String(e.originalValue),
          e.correctedValue == null ? '' : String(e.correctedValue)],
      );
      saved.push(toLog(rows[0]));
    }
    return saved;
  });
  res.status(201).json(out);
}));

app.delete('/api/documents/:id', wrap(async (req, res) => {
  const doc = await getOwnedDoc(pool, req.params.id, req.user.id);
  await pool.query('DELETE FROM documents WHERE id = $1', [doc.id]); // 이미지·추출·기록은 CASCADE
  res.status(204).end();
}));

// 전체 데이터 내보내기
app.get('/api/export', wrap(async (req, res) => {
  const q = (sql) => pool.query(sql, [req.user.id]).then((r) => r.rows);
  res.json({
    users: [req.user],
    documents: (await q('SELECT * FROM documents WHERE user_id = $1 ORDER BY created_at')).map(toDoc),
    extractedData: (await q(`SELECT e.* FROM extracted_data e JOIN documents d ON d.id = e.document_id
                              WHERE d.user_id = $1`)).map(toEx),
    lineItems: (await q(`SELECT l.* FROM line_items l JOIN extracted_data e ON e.id = l.extracted_data_id
                          JOIN documents d ON d.id = e.document_id WHERE d.user_id = $1
                          ORDER BY l.extracted_data_id, l.line_no`)).map(toItem),
    reviewLogs: (await q(`SELECT r.* FROM review_logs r JOIN documents d ON d.id = r.document_id
                           WHERE d.user_id = $1 ORDER BY r.reviewed_at`)).map(toLog),
  });
}));

app.use('/api', (req, res) => res.status(404).json({ error: '없는 API입니다' }));

// 정적 파일: 앱 셸만 공개. 서비스 워커와 index.html은 항상 새로 확인하게 한다
const PUBLIC = new Set(['index.html', 'manifest.webmanifest', 'sw.js']);
const PUBLIC_DIRS = ['css', 'js', 'icons'];
app.use((req, res, next) => {
  const p = decodeURIComponent(req.path).replace(/^\/+/, '') || 'index.html';
  if (!PUBLIC.has(p) && !PUBLIC_DIRS.some((d) => p.startsWith(d + '/'))) return res.status(404).end();
  next();
});
app.use(express.static(ROOT, {
  index: 'index.html',
  dotfiles: 'deny',
  setHeaders: (res, file) => {
    if (/(sw\.js|index\.html)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: '이미지가 너무 큽니다' });
  console.error(err);
  res.status(500).json({ error: '서버 오류' });
});

(async () => {
  await pool.query(await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8'));
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  app.listen(PORT, () => console.log(`찰칵장부 서버: http://localhost:${PORT}`));
})().catch((e) => {
  console.error('서버 시작 실패:', e.message);
  process.exit(1);
});
