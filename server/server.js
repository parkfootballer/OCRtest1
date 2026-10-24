// 찰칵장부 API 서버: Express + PostgreSQL. 프런트엔드(PWA) 정적 파일도 함께 서빙한다.
// 회원·문서·재고·학습 데이터는 모두 업장(workplace) 단위로 나뉘며, 모든 조회는 로그인한 회원의 업장으로 제한한다.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const express = require('express');
const { Pool, types } = require('pg');
const { findDuplicates } = require('./duplicates');
const { syncInventory, documentMovements } = require('./inventory');
const { upsertTrainingSample, trainingStats, exportSamples } = require('./training');
const { generateCode, normCode, nameKey } = require('./codes');
const sms = require('./sms');

// DATE는 'YYYY-MM-DD' 문자열, BIGINT·NUMERIC은 숫자로 받는다
types.setTypeParser(1082, (v) => v);
types.setTypeParser(20, (v) => (v == null ? null : Number(v)));
types.setTypeParser(1700, (v) => (v == null ? null : Number(v)));

const PORT = Number(process.env.PORT || 8080);
const ROOT = path.resolve(process.env.STATIC_ROOT || path.join(__dirname, '..'));
// 설정하면 이 코드로 "새 업장"을 만들며 가입할 수 있다 (가입자가 그 업장의 관리자가 됨)
const SIGNUP_CODE = process.env.SIGNUP_CODE || '';
const SESSION_DAYS = 30;
// 고지문 버전: js/policy.js의 PRIVACY_VERSION·TRAINING_VERSION과 같아야 한다. 문구를 바꾸면 둘 다 올린다 (기존 회원은 다시 동의)
const PRIVACY_VERSION = 'privacy-2026-10-24';
const TRAINING_VERSION = 'training-2026-10-24';
// 보관 기간 (일) — 처리방침에 적은 기간과 같아야 한다
const RETENTION = { phoneVerificationDays: 30, accessLogDays: 730 };
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // 외부에서 클라우드 DB에 붙을 때만 SSL (Render 내부 주소는 SSL 불필요)
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

const STATUSES = ['processing', 'needs_retake', 'needs_review', 'verified'];
const DOC_TYPES = ['auto', 'giro', 'bill', 'invoice', 'tax_invoice'];

// ---------- 행 → API(camelCase) 변환 ----------
const toUser = (r) => r && {
  id: r.id, email: r.email, name: r.name, role: r.role, createdAt: r.created_at, phone: r.phone || null,
  privacyConsentRequired: r.privacy_version !== PRIVACY_VERSION, // 최신 고지에 동의하지 않은 회원(기존 회원 포함)
  workplace: { id: r.workplace_id, hotelName: r.hotel_name, name: r.workplace_name },
};
const toDoc = (r) => r && {
  id: r.id, userId: r.user_id, documentType: r.document_type, imageUrl: r.image_url, status: r.status,
  retakeReason: r.retake_reason, verifiedBy: r.verified_by, verifiedAt: r.verified_at, createdAt: r.created_at,
  fileHash: r.file_hash, duplicateOf: r.duplicate_of, duplicateDecision: r.duplicate_decision,
  inventoryStatus: r.inventory_status, uploaderName: r.uploader_name,
};
const toEx = (r) => r && {
  id: r.id, documentId: r.document_id, vendorName: r.vendor_name, businessNumber: r.business_number,
  issueDate: r.issue_date, dueDate: r.due_date, totalAmount: r.total_amount, taxAmount: r.tax_amount,
  rawText: r.raw_text, confidenceScore: r.confidence_score, fieldConfidence: r.field_confidence,
  ocrConfidence: r.ocr_confidence, qualityIssues: r.quality_issues,
  customerName: r.customer_name, billingMonth: r.billing_month, documentNumber: r.document_number,
};
const toItem = (r) => ({
  id: r.id, extractedDataId: r.extracted_data_id, lineNo: r.line_no, itemName: r.item_name,
  unit: r.unit, quantity: r.quantity, unitPrice: r.unit_price, amount: r.amount,
});
const toLog = (r) => ({
  id: r.id, documentId: r.document_id, reviewerId: r.reviewer_id, fieldName: r.field_name,
  originalValue: r.original_value, correctedValue: r.corrected_value, reviewedAt: r.reviewed_at,
});
const toCode = (r) => ({
  id: r.id, code: r.code, maxUses: r.max_uses, useCount: r.use_count, expiresAt: r.expires_at,
  active: r.active, createdAt: r.created_at, createdByName: r.created_by_name,
});

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const isUuid = (s) => /^[0-9a-f-]{36}$/i.test(s);
const isHash = (s) => /^[0-9a-f]{64}$/.test(s || '');

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

const USER_SQL = `SELECT u.*, w.hotel_name, w.name AS workplace_name,
    (SELECT c.version FROM user_consents c WHERE c.user_id = u.id AND c.consent_type = 'privacy' AND c.agreed
      ORDER BY c.created_at DESC LIMIT 1) AS privacy_version
  FROM users u JOIN workplaces w ON w.id = u.workplace_id`;
const userById = async (c, id) => toUser((await c.query(`${USER_SQL} WHERE u.id = $1`, [id])).rows[0]);

async function loadUser(req, res, next) {
  const token = readCookie(req, 'sid');
  if (token) {
    const { rows } = await pool.query(
      `${USER_SQL} JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = $1 AND s.expires_at > now()`,
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
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return next(new HttpError(403, '업장 관리자만 할 수 있습니다'));
  next();
}
// 최신 개인정보 고지에 동의하지 않은 회원은 동의·로그아웃·탈퇴 외에는 쓸 수 없다
const CONSENT_FREE = ['GET /api/me', 'POST /api/consents', 'DELETE /api/me'];
function requireConsent(req, res, next) {
  if (!req.user.privacyConsentRequired || CONSENT_FREE.includes(`${req.method} ${req.baseUrl}${req.path}`)) return next();
  next(new HttpError(403, '개인정보 수집·이용 동의가 필요합니다'));
}
const wpId = (req) => req.user.workplace.id;

// ---------- 접속기록 ----------
// 개인정보처리시스템 접속기록: 계정·일시·접속지(IP)·수행 업무·대상. 응답이 끝난 뒤 남긴다(요청을 늦추지 않음)
const AUDIT_ACTIONS = {
  'POST /api/auth/signup': 'auth.signup',
  'POST /api/auth/login': 'auth.login',
  'POST /api/auth/logout': 'auth.logout',
  'POST /api/consents': 'consent.privacy',
  'DELETE /api/me': 'account.delete',
  'GET /api/workplace': 'workplace.view',
  'PATCH /api/workplace': 'workplace.update',
  'PUT /api/workplace/training-consent': 'consent.training',
  'PATCH /api/workplace/members/:id': 'member.role',
  'POST /api/workplace/codes': 'code.issue',
  'DELETE /api/workplace/codes/:id': 'code.delete',
  'GET /api/workplace/access-logs': 'access_log.view',
  // 문서 목록은 화면마다 불려 기록이 지나치게 많아지므로 제외하고, 상세 열람부터 남긴다
  'POST /api/documents': 'document.create',
  'GET /api/documents/:id': 'document.view',
  'PATCH /api/documents/:id': 'document.update',
  'PUT /api/documents/:id/extraction': 'document.save',
  'DELETE /api/documents/:id': 'document.delete',
  'GET /api/inventory/:id': 'inventory.view',
  'GET /api/export': 'data.export',
  'GET /api/training/export': 'training.export',
};
function auditMiddleware(req, res, next) {
  res.on('finish', () => {
    const action = req.route && AUDIT_ACTIONS[`${req.method} ${req.route.path}`];
    if (!action) return;
    const a = res.locals.audit || {}; // 핸들러가 채우는 값: userId(로그인·가입), targetId, detail
    const user = req.user || null;
    pool.query(
      `INSERT INTO access_logs (user_id, workplace_id, action, target_id, result, status, ip, user_agent, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [a.userId || user?.id || null, a.workplaceId || user?.workplace?.id || null, action,
        a.targetId || req.params?.id || null, res.statusCode < 400 ? 'success' : 'fail', res.statusCode,
        req.ip, String(req.headers['user-agent'] || '').slice(0, 200), a.detail ? JSON.stringify(a.detail) : null],
    ).catch((e) => console.error('접속기록 저장 실패:', e.message));
  });
  next();
}

// 업장이 OCR 학습 데이터 활용에 동의했는지
const trainingAllowed = async (c, workplaceId) =>
  !!(await c.query('SELECT 1 FROM workplaces WHERE id = $1 AND training_consent_at IS NOT NULL', [workplaceId])).rows[0];

// 로그인·가입 시도 제한: IP당 15분에 20회
const attempts = new Map();
function rateLimit(req) {
  const key = req.ip;
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.reset < now) return attempts.set(key, { n: 1, reset: now + 15 * 60_000 });
  if (++a.n > 20) throw new HttpError(429, '시도가 너무 많습니다. 잠시 후 다시 시도하세요');
}

// ---------- 가입 코드 ----------
const isMasterCode = (raw) => !!SIGNUP_CODE
  && (String(raw || '').trim() === SIGNUP_CODE || (!!normCode(SIGNUP_CODE) && normCode(raw) === normCode(SIGNUP_CODE)));

async function usableCode(c, raw, lock = false) {
  const code = normCode(raw);
  if (!code) throw new HttpError(400, '가입 코드를 입력하세요');
  const { rows } = await c.query(
    `SELECT sc.*, w.hotel_name, w.name AS workplace_name FROM signup_codes sc JOIN workplaces w ON w.id = sc.workplace_id
      WHERE sc.code = $1 ${lock ? 'FOR UPDATE OF sc' : ''}`,
    [code],
  );
  const r = rows[0];
  if (!r) throw new HttpError(403, '가입 코드가 올바르지 않습니다');
  if (!r.active) throw new HttpError(403, '사용이 중지된 가입 코드입니다');
  if (r.expires_at && new Date(r.expires_at) < new Date()) throw new HttpError(403, '만료된 가입 코드입니다');
  if (r.max_uses != null && r.use_count >= r.max_uses) throw new HttpError(403, '사용 횟수를 모두 쓴 가입 코드입니다');
  return r;
}

async function issueCode(c, workplaceId, createdBy, { expiresInDays, maxUses } = {}) {
  const days = Number(expiresInDays) > 0 ? Math.min(365, Math.floor(Number(expiresInDays))) : null;
  const uses = Number(maxUses) > 0 ? Math.min(10000, Math.floor(Number(maxUses))) : null;
  for (let i = 0; i < 5; i++) {
    const { rows } = await c.query(
      `INSERT INTO signup_codes (workplace_id, code, created_by, max_uses, expires_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(days => $5::int) END)
       ON CONFLICT (code) DO NOTHING RETURNING *`,
      [workplaceId, generateCode(), createdBy, uses, days],
    );
    if (rows[0]) return rows[0];
  }
  throw new Error('가입 코드 생성 실패');
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
// 같은 업장의 문서만 열 수 있다
async function getDoc(client, id, workplaceId, lock = false) {
  if (!isUuid(id)) throw new HttpError(404, '문서를 찾을 수 없습니다');
  const { rows } = await client.query(
    `SELECT * FROM documents WHERE id = $1 AND workplace_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [id, workplaceId],
  );
  if (!rows[0]) throw new HttpError(404, '문서를 찾을 수 없습니다');
  return rows[0];
}

async function bundle(id, workplaceId) {
  await getDoc(pool, id, workplaceId);
  const doc = (await pool.query(
    'SELECT d.*, u.name AS uploader_name FROM documents d LEFT JOIN users u ON u.id = d.user_id WHERE d.id = $1', [id],
  )).rows[0];
  const ex = (await pool.query('SELECT * FROM extracted_data WHERE document_id = $1', [id])).rows[0];
  const items = ex
    ? (await pool.query('SELECT * FROM line_items WHERE extracted_data_id = $1 ORDER BY line_no', [ex.id])).rows
    : [];
  const logs = (await pool.query('SELECT * FROM review_logs WHERE document_id = $1 ORDER BY reviewed_at DESC', [id])).rows;
  const inventory = await documentMovements(pool, id);
  let duplicateOfDoc = null;
  if (doc.duplicate_of) {
    const { rows } = await pool.query(
      `SELECT d.id, d.created_at, d.status, e.vendor_name, e.total_amount, e.issue_date
         FROM documents d LEFT JOIN extracted_data e ON e.document_id = d.id WHERE d.id = $1 AND d.workplace_id = $2`,
      [doc.duplicate_of, workplaceId],
    );
    if (rows[0]) {
      duplicateOfDoc = { id: rows[0].id, createdAt: rows[0].created_at, status: rows[0].status,
        vendorName: rows[0].vendor_name, totalAmount: rows[0].total_amount, issueDate: rows[0].issue_date };
    }
  }
  const training = (await pool.query('SELECT id, verified_at FROM training_samples WHERE document_id = $1', [id])).rows[0];
  return {
    doc: toDoc(doc), ex: toEx(ex), items: items.map(toItem), logs: logs.map(toLog), inventory, duplicateOfDoc,
    training: training ? { id: training.id, verifiedAt: training.verified_at } : null,
  };
}

// ---------- 앱 ----------
const app = express();
app.set('trust proxy', 1); // Render 등 HTTPS 프록시 뒤에서 req.secure·req.ip가 맞게 나오도록
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  // 교차 출처 격리 → 지원 브라우저에서 OCR(WebAssembly)이 여러 코어를 쓸 수 있다
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  next();
});
app.use(express.json({ limit: '20mb' }));
app.use('/api', auditMiddleware);

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

// 가입 코드 확인 → 어느 호텔·업장의 코드인지 알려 준다 (가입 화면에서 호텔명·업장명 확인용)
app.post('/api/auth/check-code', wrap(async (req, res) => {
  rateLimit(req);
  if (isMasterCode(req.body?.code)) return res.json({ valid: true, newWorkplace: true });
  const r = await usableCode(pool, req.body?.code);
  res.json({ valid: true, newWorkplace: false, hotelName: r.hotel_name, workplaceName: r.workplace_name });
}));

// ---------- 휴대폰 문자 인증 ----------
// 1) 인증번호 받기 → 2) 인증번호 확인(가입용 토큰 발급, 30분 유효) → 3) 가입 때 토큰 제출(한 번만 사용)
const CODE_TTL_SEC = 180;
const normPhone = (s) => String(s || '').replace(/\D/g, '');
const isMobile = (p) => /^01[016789]\d{7,8}$/.test(p);
const hashCode = (salt, code) => `${salt}:${sha256(`${salt}:${code}`)}`;

app.post('/api/auth/phone/send', wrap(async (req, res) => {
  const phone = normPhone(req.body?.phone);
  if (!isMobile(phone)) throw new HttpError(400, '휴대폰 번호 형식이 올바르지 않습니다');
  if (!sms.configured()) throw new HttpError(503, '문자 발송이 설정되지 않았습니다. 관리자에게 문의하세요');
  if ((await pool.query('SELECT 1 FROM users WHERE phone = $1', [phone])).rows[0]) throw new HttpError(409, '이미 가입된 휴대폰 번호입니다');
  // 발송 제한: 같은 번호 1분에 1회·1시간에 5회, 같은 IP 1시간에 20회
  const { rows: [lim] } = await pool.query(
    `SELECT count(*) FILTER (WHERE phone = $1 AND created_at > now() - interval '1 minute')::int AS recent,
            count(*) FILTER (WHERE phone = $1)::int AS phone_hour,
            count(*) FILTER (WHERE ip = $2)::int AS ip_hour
       FROM phone_verifications WHERE created_at > now() - interval '1 hour' AND (phone = $1 OR ip = $2)`,
    [phone, req.ip],
  );
  if (lim.recent) throw new HttpError(429, '잠시 후 다시 요청하세요 (1분에 한 번)');
  if (lim.phone_hour >= 5 || lim.ip_hour >= 20) throw new HttpError(429, '인증번호 요청이 너무 많습니다. 1시간 뒤 다시 시도하세요');

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const { rows: [row] } = await pool.query(
    `INSERT INTO phone_verifications (phone, code_hash, expires_at, ip)
     VALUES ($1, $2, now() + make_interval(secs => $3), $4) RETURNING id`,
    [phone, hashCode(crypto.randomBytes(8).toString('hex'), code), CODE_TTL_SEC, req.ip],
  );
  try {
    await sms.sendSms(phone, `[찰칵장부] 인증번호 ${code} (3분 안에 입력)`);
  } catch (e) {
    console.error('문자 발송 실패:', e.message);
    await pool.query('DELETE FROM phone_verifications WHERE id = $1', [row.id]);
    throw new HttpError(502, '문자를 보내지 못했습니다. 번호를 확인하고 다시 시도하세요');
  }
  // 개발용(console) 발송일 때만 화면에서 시험할 수 있도록 번호를 돌려준다
  res.json({ expiresIn: CODE_TTL_SEC, ...(sms.isConsole() && process.env.NODE_ENV !== 'production' ? { devCode: code } : {}) });
}));

app.post('/api/auth/phone/verify', wrap(async (req, res) => {
  const phone = normPhone(req.body?.phone);
  const code = String(req.body?.code || '').trim();
  const token = await withTx(async (c) => {
    const { rows: [v] } = await c.query(
      `SELECT * FROM phone_verifications WHERE phone = $1 AND verified_at IS NULL
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [phone],
    );
    if (!v || new Date(v.expires_at) < new Date()) throw new HttpError(400, '인증번호가 만료되었습니다. 다시 받아 주세요');
    if (v.attempts >= 5) throw new HttpError(429, '5회 틀렸습니다. 인증번호를 다시 받아 주세요');
    const [salt, hash] = v.code_hash.split(':');
    const ok = /^\d{6}$/.test(code)
      && crypto.timingSafeEqual(Buffer.from(hashCode(salt, code).split(':')[1], 'hex'), Buffer.from(hash, 'hex'));
    if (!ok) {
      await c.query('UPDATE phone_verifications SET attempts = attempts + 1 WHERE id = $1', [v.id]);
      return null; // 시도 횟수는 반영하고 오류는 트랜잭션 밖에서
    }
    const t = crypto.randomBytes(32).toString('base64url');
    await c.query('UPDATE phone_verifications SET verified_at = now(), token_hash = $1 WHERE id = $2', [sha256(t), v.id]);
    return t;
  });
  if (!token) throw new HttpError(400, '인증번호가 맞지 않습니다');
  res.json({ verificationToken: token });
}));

app.post('/api/auth/signup', wrap(async (req, res) => {
  rateLimit(req);
  const { email, name, password, code, hotelName, phoneToken } = req.body || {};
  const mail = String(email || '').trim().toLowerCase();
  const hotel = String(hotelName || '').trim();
  const phone = normPhone(req.body?.phone);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new HttpError(400, '이메일 형식이 올바르지 않습니다');
  if (!name || !String(name).trim()) throw new HttpError(400, '이름을 입력하세요');
  if (String(password || '').length < 8) throw new HttpError(400, '비밀번호는 8자 이상이어야 합니다');
  if (!hotel) throw new HttpError(400, '호텔명을 입력하세요');
  if (hotel.length > 80) throw new HttpError(400, '호텔명이 너무 깁니다');
  if (!isMobile(phone) || !phoneToken) throw new HttpError(400, '휴대폰 문자 인증을 완료하세요');
  // 필수 동의: 화면에 보여 준 고지문 버전과 서버의 현재 버전이 같아야 한다
  if (req.body?.consents?.privacy !== PRIVACY_VERSION) throw new HttpError(400, '개인정보 수집·이용에 동의해야 가입할 수 있습니다');

  const userId = await withTx(async (c) => {
    if ((await c.query('SELECT 1 FROM users WHERE email = $1', [mail])).rows[0]) throw new HttpError(409, '이미 가입된 이메일입니다');
    if ((await c.query('SELECT 1 FROM users WHERE phone = $1', [phone])).rows[0]) throw new HttpError(409, '이미 가입된 휴대폰 번호입니다');
    // 문자 인증: 같은 번호로 30분 안에 인증받은, 아직 쓰지 않은 토큰이어야 한다
    const { rows: [pv] } = await c.query(
      `SELECT id FROM phone_verifications
        WHERE phone = $1 AND token_hash = $2 AND used_at IS NULL AND verified_at > now() - interval '30 minutes'
        FOR UPDATE`,
      [phone, sha256(String(phoneToken))],
    );
    if (!pv) throw new HttpError(400, '휴대폰 인증이 만료되었습니다. 다시 인증해 주세요');
    await c.query('UPDATE phone_verifications SET used_at = now() WHERE id = $1', [pv.id]);

    let workplaceId;
    let role = 'member';
    if (isMasterCode(code)) {
      // 새 업장 개설: 업장명은 '기본 업장'으로 만들고 관리자가 내 정보에서 바꾼다
      const { rows } = await c.query(
        `INSERT INTO workplaces (hotel_name, name) VALUES ($1, '기본 업장')
         ON CONFLICT (hotel_key, name_key) DO NOTHING RETURNING id`,
        [hotel],
      );
      if (!rows[0]) throw new HttpError(409, '이미 등록된 호텔입니다. 업장 관리자에게 가입 코드를 받아 가입하세요');
      workplaceId = rows[0].id;
      role = 'admin';
    } else {
      // 업장은 가입 코드로 정해진다. 호텔명은 코드의 호텔과 맞는지만 확인한다
      const sc = await usableCode(c, code, true);
      if (nameKey(sc.hotel_name) !== nameKey(hotel)) throw new HttpError(400, '가입 코드의 호텔명과 입력한 호텔명이 다릅니다');
      await c.query('UPDATE signup_codes SET use_count = use_count + 1 WHERE id = $1', [sc.id]);
      workplaceId = sc.workplace_id;
    }
    const { rows } = await c.query(
      `INSERT INTO users (email, name, password_hash, workplace_id, role, phone, phone_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (email) DO NOTHING RETURNING id`,
      [mail, String(name).trim(), await hashPassword(password), workplaceId, role, phone],
    );
    if (!rows[0]) throw new HttpError(409, '이미 가입된 이메일입니다');
    await c.query(
      `INSERT INTO user_consents (user_id, consent_type, version, agreed, ip) VALUES ($1, 'privacy', $2, true, $3)`,
      [rows[0].id, PRIVACY_VERSION, req.ip],
    );
    res.locals.audit = { userId: rows[0].id, workplaceId };
    return rows[0].id;
  });
  await startSession(req, res, userId);
  res.status(201).json(await userById(pool, userId));
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  rateLimit(req);
  const mail = String(req.body?.email || '').trim().toLowerCase();
  const { rows } = await pool.query(`${USER_SQL} WHERE u.email = $1`, [mail]);
  res.locals.audit = rows[0] ? { userId: rows[0].id, workplaceId: rows[0].workplace_id } : { detail: { email: mail.slice(0, 100) } };
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

// 가입에는 항상 업장 가입 코드가 필요하다
app.get('/api/auth/config', (req, res) => res.json({
  signupCodeRequired: true, canCreateWorkplace: !!SIGNUP_CODE, phoneVerification: true, smsConfigured: sms.configured(),
  privacyVersion: PRIVACY_VERSION, trainingVersion: TRAINING_VERSION, retention: RETENTION,
}));

// 이하 모든 API는 로그인 + 최신 개인정보 고지 동의 필요
app.use('/api', requireUser);
app.use('/api', requireConsent);

app.get('/api/me', (req, res) => res.json(req.user));

// 기존 회원·고지문 변경 시 다시 동의
app.post('/api/consents', wrap(async (req, res) => {
  if (req.body?.privacy !== PRIVACY_VERSION) throw new HttpError(400, '최신 고지문에 동의해 주세요');
  await pool.query(
    `INSERT INTO user_consents (user_id, consent_type, version, agreed, ip) VALUES ($1, 'privacy', $2, true, $3)`,
    [req.user.id, PRIVACY_VERSION, req.ip],
  );
  res.json(await userById(pool, req.user.id));
}));

// 회원 탈퇴: 비밀번호 확인 후 계정·세션·동의 기록을 지운다.
// 업장 문서는 업장 자료이므로 남기고 올린 사람만 비운다. 접속기록은 보관 기간 동안 남는다
app.delete('/api/me', wrap(async (req, res) => {
  const { rows: [u] } = await pool.query('SELECT password_hash, role, workplace_id FROM users WHERE id = $1', [req.user.id]);
  // 401은 앱이 "세션 만료"로 처리하므로 비밀번호 오류는 400
  if (!(await verifyPassword(String(req.body?.password || ''), u.password_hash))) throw new HttpError(400, '비밀번호가 맞지 않습니다');
  await withTx(async (c) => {
    if (u.role === 'admin') {
      const { rows: [n] } = await c.query(
        `SELECT count(*) FILTER (WHERE role = 'admin')::int AS admins, count(*)::int AS members FROM users WHERE workplace_id = $1`,
        [u.workplace_id],
      );
      if (n.admins === 1 && n.members > 1) throw new HttpError(409, '업장의 마지막 관리자입니다. 다른 구성원을 관리자로 지정한 뒤 탈퇴하세요');
    }
    await c.query('DELETE FROM users WHERE id = $1', [req.user.id]); // 세션·동의 기록은 CASCADE
  });
  setSessionCookie(req, res, '', 0);
  res.status(204).end();
}));

// ---------- 업장 ----------
app.get('/api/workplace', wrap(async (req, res) => {
  const members = (await pool.query(
    'SELECT id, name, email, role, created_at FROM users WHERE workplace_id = $1 ORDER BY created_at', [wpId(req)],
  )).rows.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, createdAt: r.created_at }));
  const codes = req.user.role === 'admin' ? (await pool.query(
    `SELECT sc.*, u.name AS created_by_name FROM signup_codes sc LEFT JOIN users u ON u.id = sc.created_by
      WHERE sc.workplace_id = $1 AND sc.active ORDER BY sc.created_at DESC LIMIT 50`, [wpId(req)],
  )).rows.map(toCode) : [];
  const { rows: [tc] } = await pool.query(
    `SELECT w.training_consent_at, w.training_consent_version, u.name AS by_name
       FROM workplaces w LEFT JOIN users u ON u.id = w.training_consent_by WHERE w.id = $1`,
    [wpId(req)],
  );
  const trainingConsent = tc.training_consent_at
    ? { agreedAt: tc.training_consent_at, version: tc.training_consent_version, byName: tc.by_name, current: tc.training_consent_version === TRAINING_VERSION }
    : null;
  res.json({ workplace: req.user.workplace, role: req.user.role, members, codes, trainingConsent });
}));

// OCR 학습 데이터 활용 동의(선택) — 업장 관리자가 소유주를 대신해 동의·철회한다.
// 철회하면 그 업장에서 모은 학습 데이터(최초 OCR 결과·검수 묶음)를 바로 파기한다
app.put('/api/workplace/training-consent', requireAdmin, wrap(async (req, res) => {
  const agree = req.body?.agree === true;
  const out = await withTx(async (c) => {
    if (agree) {
      if (req.body?.version !== TRAINING_VERSION) throw new HttpError(400, '최신 동의 문구를 확인해 주세요');
      await c.query(
        'UPDATE workplaces SET training_consent_at = now(), training_consent_by = $1, training_consent_version = $2 WHERE id = $3',
        [req.user.id, TRAINING_VERSION, wpId(req)],
      );
      return { agreed: true };
    }
    await c.query('UPDATE workplaces SET training_consent_at = NULL, training_consent_by = NULL, training_consent_version = NULL WHERE id = $1', [wpId(req)]);
    const s = await c.query('DELETE FROM training_samples WHERE workplace_id = $1', [wpId(req)]);
    const o = await c.query('DELETE FROM ocr_results o USING documents d WHERE d.id = o.document_id AND d.workplace_id = $1', [wpId(req)]);
    return { agreed: false, deletedSamples: s.rowCount, deletedOcrResults: o.rowCount };
  });
  res.locals.audit = { detail: out };
  res.json(out);
}));

// 구성원 권한 변경 (관리자 지정·해제). 관리자가 한 명도 남지 않게 할 수는 없다
app.patch('/api/workplace/members/:id', requireAdmin, wrap(async (req, res) => {
  const role = req.body?.role;
  if (!['admin', 'member'].includes(role) || !isUuid(req.params.id)) throw new HttpError(400, '잘못된 요청입니다');
  await withTx(async (c) => {
    const { rowCount } = await c.query('UPDATE users SET role = $1 WHERE id = $2 AND workplace_id = $3', [role, req.params.id, wpId(req)]);
    if (!rowCount) throw new HttpError(404, '구성원이 없습니다');
    const { rows: [n] } = await c.query(`SELECT count(*)::int AS n FROM users WHERE workplace_id = $1 AND role = 'admin'`, [wpId(req)]);
    if (!n.n) throw new HttpError(409, '업장에 관리자가 한 명은 있어야 합니다');
  });
  res.status(204).end();
}));

// 접속기록 열람 (관리자 점검용, 최근 200건)
app.get('/api/workplace/access-logs', requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.*, u.name AS user_name FROM access_logs l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.workplace_id = $1 ORDER BY l.at DESC LIMIT 200`,
    [wpId(req)],
  );
  res.json(rows.map((r) => ({
    id: r.id, at: r.at, userId: r.user_id, userName: r.user_name, action: r.action, targetId: r.target_id,
    result: r.result, status: r.status, ip: r.ip,
  })));
}));

app.patch('/api/workplace', requireAdmin, wrap(async (req, res) => {
  const hotel = String(req.body?.hotelName || '').trim();
  const name = String(req.body?.name || '').trim();
  if (!hotel || !name) throw new HttpError(400, '호텔명과 업장명을 입력하세요');
  try {
    await pool.query('UPDATE workplaces SET hotel_name = $1, name = $2 WHERE id = $3', [hotel, name, wpId(req)]);
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, '같은 호텔에 같은 이름의 업장이 이미 있습니다');
    throw e;
  }
  res.json(await userById(pool, req.user.id));
}));

app.post('/api/workplace/codes', requireAdmin, wrap(async (req, res) => {
  const r = await issueCode(pool, wpId(req), req.user.id, req.body || {});
  res.status(201).json(toCode(r));
}));

// 가입 코드 삭제: 행을 지우므로 그 코드로는 더 이상 가입할 수 없고 목록에서도 사라진다 (이미 가입한 구성원은 그대로)
app.delete('/api/workplace/codes/:id', requireAdmin, wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, '가입 코드가 없습니다');
  const { rowCount } = await pool.query(
    'DELETE FROM signup_codes WHERE id = $1 AND workplace_id = $2', [req.params.id, wpId(req)],
  );
  if (!rowCount) throw new HttpError(404, '가입 코드가 없습니다');
  res.status(204).end();
}));

app.get('/api/images/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, '이미지가 없습니다');
  const { rows } = await pool.query(
    `SELECT i.mime, i.data FROM images i JOIN documents d ON d.id = i.document_id
      WHERE i.id = $1 AND d.workplace_id = $2`,
    [req.params.id, wpId(req)],
  );
  if (!rows[0]) throw new HttpError(404, '이미지가 없습니다');
  res.setHeader('Content-Type', rows[0].mime);
  res.setHeader('Cache-Control', 'private, max-age=604800, immutable'); // 이미지 id는 내용이 바뀌지 않음
  res.end(rows[0].data);
}));

// 문서 목록 (+ 추출 요약)
app.get('/api/documents', wrap(async (req, res) => {
  const params = [wpId(req)];
  let where = 'd.workplace_id = $1';
  if (req.query.status) {
    const list = String(req.query.status).split(',').filter((s) => STATUSES.includes(s));
    params.push(list);
    where += ` AND d.status = ANY($${params.length})`;
  }
  const { rows } = await pool.query(
    `SELECT d.*, u.name AS uploader_name, CASE WHEN e.id IS NULL THEN NULL ELSE row_to_json(e) END AS ex
       FROM documents d LEFT JOIN extracted_data e ON e.document_id = d.id LEFT JOIN users u ON u.id = d.user_id
      WHERE ${where}
      ORDER BY d.created_at DESC`,
    params,
  );
  res.json(rows.map((r) => ({ doc: toDoc(r), ex: toEx(r.ex) })));
}));

// 업로드 전 중복 확인 (같은 파일)
app.post('/api/duplicates/check', wrap(async (req, res) => {
  const fileHash = String(req.body?.fileHash || '');
  if (!isHash(fileHash)) return res.json([]);
  res.json(await findDuplicates(pool, wpId(req), { fileHash }));
}));

// 문서 생성 (촬영 이미지 업로드)
app.post('/api/documents', wrap(async (req, res) => {
  const { documentType = 'auto', image, fileHash, duplicateOf } = req.body || {};
  if (!DOC_TYPES.includes(documentType)) throw new HttpError(400, '알 수 없는 documentType');
  decodeImage(image); // 형식 오류를 트랜잭션 전에 걸러낸다
  const doc = await withTx(async (c) => {
    // 사용자가 중복 경고를 보고도 등록한 경우 → 원본을 기록하고 재고에는 반영하지 않는다
    const dupOf = duplicateOf ? (await getDoc(c, duplicateOf, wpId(req))).id : null;
    const { rows } = await c.query(
      `INSERT INTO documents (user_id, workplace_id, document_type, file_hash, duplicate_of, duplicate_decision)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.id, wpId(req), documentType, isHash(fileHash) ? fileHash : null, dupOf, dupOf ? 'duplicate' : null],
    );
    const url = await storeImage(c, rows[0].id, image);
    return (await c.query('UPDATE documents SET image_url = $1 WHERE id = $2 RETURNING *', [url, rows[0].id])).rows[0];
  });
  res.locals.audit = { targetId: doc.id };
  res.status(201).json(toDoc(doc));
}));

app.get('/api/documents/:id', wrap(async (req, res) => {
  res.json(await bundle(req.params.id, wpId(req)));
}));

// 등록 전 중복 확인 (추출된 공급업체·문서번호·작성일·총액 기준)
app.get('/api/documents/:id/duplicates', wrap(async (req, res) => {
  const doc = await getDoc(pool, req.params.id, wpId(req));
  res.json(await findDuplicates(pool, wpId(req), { docId: doc.id }));
}));

// 상태·종류 변경, 재촬영 시 이미지 교체, 중복 판단 기록
app.patch('/api/documents/:id', wrap(async (req, res) => {
  const b = req.body || {};
  const doc = await withTx(async (c) => {
    const old = await getDoc(c, req.params.id, wpId(req), true);
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
    if (b.fileHash !== undefined) set('file_hash', isHash(b.fileHash) ? b.fileHash : null); // 재촬영한 파일
    if (b.duplicateDecision !== undefined) {
      if (![null, 'duplicate', 'distinct'].includes(b.duplicateDecision)) throw new HttpError(400, '알 수 없는 duplicateDecision');
      let dupOf = null;
      if (b.duplicateDecision === 'duplicate') {
        if (!b.duplicateOf || b.duplicateOf === old.id) throw new HttpError(400, '원본 문서를 지정하세요');
        dupOf = (await getDoc(c, b.duplicateOf, wpId(req))).id;
      }
      set('duplicate_decision', b.duplicateDecision);
      set('duplicate_of', dupOf);
    }
    if (b.image !== undefined) {
      const url = await storeImage(c, old.id, b.image);
      await c.query('DELETE FROM images WHERE document_id = $1 AND id <> $2', [old.id, url.split('/').pop()]);
      // 이미지가 바뀌면 예전 이미지 기준의 OCR 결과·학습 데이터는 의미가 없다
      await c.query('DELETE FROM ocr_results WHERE document_id = $1', [old.id]);
      await c.query('DELETE FROM training_samples WHERE document_id = $1', [old.id]);
      set('image_url', url);
    }
    if (!sets.length) return old;
    vals.push(old.id);
    const updated = (await c.query(`UPDATE documents SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals)).rows[0];
    await syncInventory(c, updated.id, req.user.id);
    // 사람이 검수 완료한 순간의 이미지·최초 OCR·확정값을 학습 데이터로 묶어 둔다
    // 업장이 학습 데이터 활용에 동의한 경우에만
    if (b.status === 'verified' && updated.verified_by && updated.verified_by !== 'auto' && (await trainingAllowed(c, updated.workplace_id))) {
      await upsertTrainingSample(c, updated, req.user.id);
    }
    return (await c.query('SELECT * FROM documents WHERE id = $1', [updated.id])).rows[0];
  });
  res.json(toDoc(doc));
}));

// 추출 결과 저장 — 기존 추출/품목을 트랜잭션으로 통째로 교체하고 재고 반영도 다시 맞춘다
app.put('/api/documents/:id/extraction', wrap(async (req, res) => {
  const { data = {}, items = [] } = req.body || {};
  const id = req.params.id;
  await withTx(async (c) => {
    await getDoc(c, id, wpId(req), true);
    await c.query('DELETE FROM extracted_data WHERE document_id = $1', [id]);
    const { rows } = await c.query(
      `INSERT INTO extracted_data (document_id, vendor_name, business_number, issue_date, due_date,
         total_amount, tax_amount, raw_text, confidence_score, field_confidence, ocr_confidence, quality_issues,
         customer_name, billing_month, document_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [id, data.vendorName || null, data.businessNumber || null, data.issueDate || null, data.dueDate || null,
        data.totalAmount ?? null, data.taxAmount ?? null, data.rawText || '', data.confidenceScore ?? null,
        JSON.stringify(data.fieldConfidence || {}), data.ocrConfidence ?? null, JSON.stringify(data.qualityIssues || []),
        data.customerName || null, /^\d{4}-\d{2}$/.test(data.billingMonth || '') ? data.billingMonth : null,
        String(data.documentNumber || '').trim().slice(0, 60) || null],
    );
    for (const [i, it] of items.entries()) {
      await c.query(
        `INSERT INTO line_items (extracted_data_id, line_no, item_name, unit, quantity, unit_price, amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [rows[0].id, i + 1, it.itemName || '', String(it.unit || '').trim().slice(0, 20) || null,
          it.quantity ?? null, it.unitPrice ?? null, it.amount ?? null],
      );
    }
    await syncInventory(c, id, req.user.id);
  });
  res.json(await bundle(id, wpId(req)));
}));

// 최초 OCR 결과 저장 (학습 데이터의 "원래 인식값"). 학습 활용에 동의하지 않은 업장은 저장하지 않는다(최소 수집)
app.post('/api/documents/:id/ocr-results', wrap(async (req, res) => {
  const { engine, modelVersion, result, parsed } = req.body || {};
  if (!engine || !result || !parsed || !Array.isArray(result.words)) throw new HttpError(400, 'engine·result·parsed가 필요합니다');
  if (result.words.length > 10000) throw new HttpError(413, 'OCR 결과가 너무 큽니다');
  const doc = await getDoc(pool, req.params.id, wpId(req));
  if (!(await trainingAllowed(pool, doc.workplace_id))) return res.status(204).end();
  const imageId = String(doc.image_url || '').split('/').pop();
  const { rows } = await pool.query(
    `INSERT INTO ocr_results (document_id, image_id, engine, model_version, result, parsed)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
    [doc.id, isUuid(imageId) ? imageId : null, String(engine).slice(0, 40), modelVersion ? String(modelVersion).slice(0, 200) : null,
      JSON.stringify(result), JSON.stringify(parsed)],
  );
  res.status(201).json({ id: rows[0].id, createdAt: rows[0].created_at });
}));

// 검수 기록 추가 (여러 건 한 번에)
app.post('/api/documents/:id/review-logs', wrap(async (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [req.body];
  const id = req.params.id;
  const out = await withTx(async (c) => {
    await getDoc(c, id, wpId(req));
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

// 문서 삭제: 이미지·추출·OCR 결과·검수 기록·학습 데이터·입고 내역이 함께 지워진다(CASCADE).
// 입고 내역이 지워지면 현재고(입고 합계)도 그만큼 줄어든다.
app.delete('/api/documents/:id', wrap(async (req, res) => {
  const out = await withTx(async (c) => {
    const doc = await getDoc(c, req.params.id, wpId(req), true);
    const reverted = await documentMovements(c, doc.id);
    // 이 문서를 원본으로 둔 "중복 등록" 문서가 있으면, 가장 먼저 올라온 것을 새 원본으로 삼아 재고에 대신 반영한다
    const { rows: dups } = await c.query(
      'SELECT id FROM documents WHERE duplicate_of = $1 ORDER BY created_at FOR UPDATE', [doc.id],
    );
    const promoted = dups[0]?.id || null;
    if (promoted) {
      await c.query(`UPDATE documents SET duplicate_of = NULL, duplicate_decision = 'distinct' WHERE id = $1`, [promoted]);
      await c.query('UPDATE documents SET duplicate_of = $1 WHERE duplicate_of = $2 AND id <> $1', [promoted, doc.id]);
    }
    await c.query('DELETE FROM documents WHERE id = $1', [doc.id]);
    const promotedSync = promoted ? await syncInventory(c, promoted, req.user.id) : null;
    return { deleted: doc.id, revertedItems: reverted, promotedDocumentId: promoted, promotedInventory: promotedSync };
  });
  res.json(out);
}));

// 거래처 기억: 사람이 검수해 확정한(자동 확정 제외) 상호·고객명. 인식 오타를 이 이름들로 보정한다
app.get('/api/memory', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT array_remove(array_agg(DISTINCT e.vendor_name), NULL) AS vendors,
            array_remove(array_agg(DISTINCT e.customer_name), NULL) AS customers
       FROM extracted_data e JOIN documents d ON d.id = e.document_id
      WHERE d.workplace_id = $1 AND d.status = 'verified' AND d.verified_by IS DISTINCT FROM 'auto'`,
    [wpId(req)],
  );
  res.json({ vendors: rows[0].vendors || [], customers: rows[0].customers || [] });
}));

// ---------- 재고 ----------
app.get('/api/inventory', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.id, i.name, i.unit, COALESCE(sum(m.quantity), 0) AS quantity, count(m.id)::int AS movements,
            max(m.created_at) AS last_in_at
       FROM inventory_items i JOIN inventory_movements m ON m.item_id = i.id
      WHERE i.workplace_id = $1
      GROUP BY i.id
      ORDER BY i.name`,
    [wpId(req)],
  );
  res.json(rows.map((r) => ({ id: r.id, name: r.name, unit: r.unit, quantity: r.quantity, movements: r.movements, lastInAt: r.last_in_at })));
}));

app.get('/api/inventory/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, '품목이 없습니다');
  const item = (await pool.query('SELECT * FROM inventory_items WHERE id = $1 AND workplace_id = $2', [req.params.id, wpId(req)])).rows[0];
  if (!item) throw new HttpError(404, '품목이 없습니다');
  const { rows } = await pool.query(
    `SELECT m.*, d.document_type, d.created_at AS doc_created_at, e.vendor_name, e.issue_date, e.document_number
       FROM inventory_movements m
       LEFT JOIN documents d ON d.id = m.document_id
       LEFT JOIN extracted_data e ON e.document_id = d.id
      WHERE m.item_id = $1 ORDER BY COALESCE(e.issue_date::timestamptz, m.created_at) DESC, m.created_at DESC`,
    [item.id],
  );
  res.json({
    item: { id: item.id, name: item.name, unit: item.unit, quantity: rows.reduce((s, r) => s + Number(r.quantity), 0) },
    movements: rows.map((r) => ({
      id: r.id, kind: r.kind, quantity: r.quantity, itemName: r.item_name, createdAt: r.created_at, documentId: r.document_id,
      documentType: r.document_type, vendorName: r.vendor_name, issueDate: r.issue_date, documentNumber: r.document_number,
    })),
  });
}));

// ---------- 학습 데이터 (업장 관리자) ----------
app.get('/api/training/stats', requireAdmin, wrap(async (req, res) => {
  res.json(await trainingStats(pool, wpId(req)));
}));

app.get('/api/training/export', requireAdmin, wrap(async (req, res) => {
  const documentType = DOC_TYPES.includes(req.query.documentType) ? req.query.documentType : null;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const out = await exportSamples(pool, wpId(req), { documentType, limit, offset });
  res.json({ format: 'chalkak-training-v1', workplace: req.user.workplace, exportedAt: new Date().toISOString(), ...out });
}));

// 전체 데이터 내보내기 (업장 범위)
app.get('/api/export', wrap(async (req, res) => {
  const q = (sql) => pool.query(sql, [wpId(req)]).then((r) => r.rows);
  res.json({
    workplace: req.user.workplace,
    users: [req.user],
    documents: (await q('SELECT * FROM documents WHERE workplace_id = $1 ORDER BY created_at')).map(toDoc),
    extractedData: (await q(`SELECT e.* FROM extracted_data e JOIN documents d ON d.id = e.document_id
                              WHERE d.workplace_id = $1`)).map(toEx),
    lineItems: (await q(`SELECT l.* FROM line_items l JOIN extracted_data e ON e.id = l.extracted_data_id
                          JOIN documents d ON d.id = e.document_id WHERE d.workplace_id = $1
                          ORDER BY l.extracted_data_id, l.line_no`)).map(toItem),
    reviewLogs: (await q(`SELECT r.* FROM review_logs r JOIN documents d ON d.id = r.document_id
                           WHERE d.workplace_id = $1 ORDER BY r.reviewed_at`)).map(toLog),
    inventoryItems: (await q('SELECT id, name, unit, created_at FROM inventory_items WHERE workplace_id = $1 ORDER BY name')),
    inventoryMovements: (await q(`SELECT id, item_id, document_id, line_no, kind, quantity, item_name, created_at
                                    FROM inventory_movements WHERE workplace_id = $1 ORDER BY created_at`)),
  });
}));

app.use('/api', (req, res) => res.status(404).json({ error: '없는 API입니다' }));

// 정적 파일: 앱 셸만 공개. 서비스 워커와 index.html은 항상 새로 확인하게 한다
const PUBLIC = new Set(['index.html', 'manifest.webmanifest', 'sw.js']);
const PUBLIC_DIRS = ['css', 'js', 'icons', 'models', 'samples'];
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

// 보관 기간이 지난 데이터 파기: 만료 세션, 30일 지난 문자 인증 기록(번호·IP), 2년 지난 접속기록
async function purgeExpired() {
  const r = await Promise.all([
    pool.query('DELETE FROM sessions WHERE expires_at < now()'),
    pool.query(`DELETE FROM phone_verifications WHERE created_at < now() - make_interval(days => $1)`, [RETENTION.phoneVerificationDays]),
    pool.query(`DELETE FROM access_logs WHERE at < now() - make_interval(days => $1)`, [RETENTION.accessLogDays]),
  ]);
  const n = r.map((x) => x.rowCount);
  if (n.some(Boolean)) console.log(`보관 기간 지난 데이터 파기: 세션 ${n[0]} · 문자 인증 ${n[1]} · 접속기록 ${n[2]}`);
}

(async () => {
  await pool.query(await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8'));
  await purgeExpired();
  setInterval(() => purgeExpired().catch((e) => console.error('파기 작업 실패:', e.message)), 6 * 3600_000);
  app.listen(PORT, () => console.log(`찰칵장부 서버: http://localhost:${PORT}`));
})().catch((e) => {
  console.error('서버 시작 실패:', e.message);
  process.exit(1);
});
