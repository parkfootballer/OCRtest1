// 업장 관리 명령 (서버 관리자용)
//   node --env-file=.env manage.js workplaces                       업장 목록
//   node --env-file=.env manage.js create-workplace <업장코드> <업장명>  업장을 미리 만든다 (이 코드로 가입하면 승인 대기로 합류)
//   node --env-file=.env manage.js issue-code <업장 id> [유효일수] [최대 사용 횟수]
//   node --env-file=.env manage.js make-admin <이메일>               같은 업장의 관리자로 지정
//   node --env-file=.env manage.js db-user-add <이름> [--read-only]  팀원 DB 계정 발급 (조회·수정, 또는 조회만)
//   node --env-file=.env manage.js db-user-remove <이름>             팀원 DB 계정 삭제
//   node --env-file=.env manage.js db-users                          팀원 DB 계정 목록
//   node --env-file=.env manage.js api-client-add <이름> [--all]     외부 연동 API 키 발급 (예: hso). --all: 지점 연결 없이 모든 업장
//   node --env-file=.env manage.js api-client-scope <이름> all|mapped 범위 변경 (모든 업장 / 연결한 지점만)
//   node --env-file=.env manage.js api-client-map <이름> <업장 id> <지점 코드>   업장 ↔ 상대 지점 연결
//   node --env-file=.env manage.js api-client-unmap <이름> <지점 코드>
//   node --env-file=.env manage.js api-client-rotate <이름>          키 재발급 (기존 키 즉시 무효)
//   node --env-file=.env manage.js api-client-revoke <이름>          연동 중지
//   node --env-file=.env manage.js api-clients                       연동 목록·매핑
// 서버를 한 번 이상 실행해 schema.sql이 적용된 DB에서 쓴다.
// DB 계정 명령은 역할을 만들 수 있는 계정이 필요하다: ADMIN_DATABASE_URL(있으면) 또는 DATABASE_URL
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { generateCode } = require('./codes');

const ssl = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });

// ---------- 팀원 DB 계정 ----------
// 사람마다 따로 로그인 계정을 주고(누가 접속했는지 구분, 개별 회수 가능), 권한은 두 묶음 중 하나에 넣는다
//   chalkak_rw: 모든 테이블 조회·추가·수정·삭제 (테이블 구조 변경·TRUNCATE 불가, 접속기록은 조회·추가만 — 변조 방지)
//   chalkak_ro: 모든 테이블 조회만
const GROUPS = { rw: 'chalkak_rw', ro: 'chalkak_ro' };
const adminUrl = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL;

async function setupGroups(c) {
  const { rows: [{ owner }] } = await c.query(`SELECT tableowner AS owner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'documents'`);
  for (const g of Object.values(GROUPS)) {
    if (!(await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [g])).rows[0]) await c.query(`CREATE ROLE ${g} NOLOGIN`);
  }
  const db = (await c.query('SELECT current_database() AS d')).rows[0].d;
  await c.query(`GRANT CONNECT ON DATABASE "${db}" TO ${GROUPS.rw}, ${GROUPS.ro}`);
  await c.query(`GRANT USAGE ON SCHEMA public TO ${GROUPS.rw}, ${GROUPS.ro}`);
  await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${GROUPS.ro}`);
  await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${GROUPS.rw}`);
  await c.query(`REVOKE UPDATE, DELETE ON access_logs FROM ${GROUPS.rw}`);
  await c.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${GROUPS.rw}`);
  // 앞으로 서버가 새로 만드는 테이블에도 같은 권한
  await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public GRANT SELECT ON TABLES TO ${GROUPS.ro}`);
  await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${GROUPS.rw}`);
  await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${GROUPS.rw}`);
}

const roleName = (name) => {
  const n = String(name || '').toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(n)) throw new Error('이름은 영문 소문자로 시작하는 영문·숫자·_ 2~31자 (예: kim_dev)');
  return `team_${n}`;
};

async function dbUserAdd(name, readOnly) {
  const role = roleName(name);
  const admin = new Pool({ connectionString: adminUrl, ssl });
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await setupGroups(c);
    if ((await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rows[0]) throw new Error(`${role} 계정이 이미 있습니다. 먼저 db-user-remove 하세요`);
    const password = crypto.randomBytes(18).toString('base64url');
    // 비밀번호는 식별자가 아닌 문자열 리터럴이라 escape 함수로 안전하게 넣는다
    await c.query(`CREATE ROLE ${role} LOGIN PASSWORD ${c.escapeLiteral(password)} IN ROLE ${readOnly ? GROUPS.ro : GROUPS.rw} CONNECTION LIMIT 5`);
    await c.query('COMMIT');
    const u = new URL(process.env.DATABASE_URL);
    u.username = role;
    u.password = password;
    console.log(`DB 계정 발급: ${role} (${readOnly ? '조회만' : '조회·수정'})`);
    console.log(`접속 주소 (비밀번호는 지금 한 번만 표시 — 안전한 방법으로 본인에게만 전달):\n${u.toString()}`);
    if (/localhost|127\.0\.0\.1/.test(u.hostname)) console.log('※ 로컬 DB 주소입니다. 운영 DB는 Render의 External Database URL로 실행하세요');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    if (e.code === '42501') throw new Error('이 DB 계정에는 역할을 만들 권한이 없습니다. ADMIN_DATABASE_URL에 관리자 계정 주소를 넣어 실행하세요');
    throw e;
  } finally {
    c.release();
    await admin.end();
  }
}

// ---------- 외부 연동 API 키 ----------
const newApiKey = () => `chk_${crypto.randomBytes(30).toString('base64url')}`;
const keyHash = (k) => crypto.createHash('sha256').update(k).digest('hex');
async function apiClient(name) {
  const { rows: [c] } = await pool.query('SELECT * FROM api_clients WHERE name = $1', [String(name || '').toLowerCase()]);
  if (!c) throw new Error(`연동 '${name}'이(가) 없습니다. api-clients로 목록을 확인하세요`);
  return c;
}
function printKey(key) {
  console.log(`API 키 (지금 한 번만 표시 — 상대 담당자에게만 안전하게 전달):\n${key}`);
}

async function dbUserRemove(name) {
  const role = roleName(name);
  const admin = new Pool({ connectionString: adminUrl, ssl });
  try {
    // 접속 중인 세션을 끊고 계정 삭제
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1', [role]);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    console.log(`DB 계정 삭제: ${role}`);
  } finally {
    await admin.end();
  }
}
const fmtCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;

async function issue(workplaceId, days, uses) {
  const { rows } = await pool.query(
    `INSERT INTO signup_codes (workplace_id, code, max_uses, expires_at)
     VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(days => $4::int) END) RETURNING *`,
    [workplaceId, generateCode(), uses || null, days || null],
  );
  return rows[0];
}

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'workplaces': {
      const { rows } = await pool.query(
        `SELECT w.id, w.code, w.hotel_name, w.name, count(u.id)::int AS members FROM workplaces w
           LEFT JOIN users u ON u.workplace_id = w.id GROUP BY w.id ORDER BY w.hotel_name, w.name`,
      );
      console.table(rows);
      break;
    }
    case 'create-workplace': {
      const [code, name] = args;
      if (!code || !name) throw new Error('사용법: create-workplace <업장코드> <업장명>');
      const { rows } = await pool.query('INSERT INTO workplaces (hotel_name, name, code) VALUES ($1, $2, $1) RETURNING id', [code, name]);
      console.log(`업장 생성: ${code} / ${name} (${rows[0].id})`);
      console.log('이 업장코드로 가입한 사람은 승인 대기로 들어갑니다. 첫 관리자는 가입 후 make-admin 으로 지정하고 승인하세요');
      break;
    }
    case 'issue-code': {
      const [id, days, uses] = args;
      if (!id) throw new Error('사용법: issue-code <업장 id> [유효일수] [최대 사용 횟수]');
      const code = await issue(id, Number(days) || null, Number(uses) || null);
      console.log(`가입 코드: ${fmtCode(code.code)}`);
      break;
    }
    case 'make-admin': {
      // 관리자로 지정하면서 승인 대기도 풀어 준다
      const { rowCount } = await pool.query(`UPDATE users SET role = 'admin', status = 'active' WHERE email = $1`, [String(args[0] || '').toLowerCase()]);
      console.log(rowCount ? '관리자로 지정했습니다' : '해당 이메일의 회원이 없습니다');
      break;
    }
    case 'db-user-add':
      await dbUserAdd(args[0], args.includes('--read-only'));
      break;
    case 'db-user-remove':
      await dbUserRemove(args[0]);
      break;
    case 'db-users': {
      const { rows } = await pool.query(
        `SELECT r.rolname AS account, g.rolname AS access, r.rolconnlimit AS max_conn
           FROM pg_roles r JOIN pg_auth_members m ON m.member = r.oid JOIN pg_roles g ON g.oid = m.roleid
          WHERE r.rolname LIKE 'team\\_%' AND g.rolname IN ('chalkak_rw', 'chalkak_ro') ORDER BY 1`,
      );
      console.table(rows.map((r) => ({ ...r, access: r.access === 'chalkak_rw' ? '조회·수정' : '조회만' })));
      break;
    }
    case 'api-client-add': {
      const name = String(args[0] || '').toLowerCase();
      if (!/^[a-z][a-z0-9_-]{1,30}$/.test(name)) throw new Error('이름은 영문 소문자로 시작하는 2~31자 (예: hso)');
      const all = args.includes('--all');
      const key = newApiKey();
      await pool.query('INSERT INTO api_clients (name, key_hash, key_prefix, all_workplaces) VALUES ($1, $2, $3, $4)',
        [name, keyHash(key), key.slice(0, 12), all]);
      console.log(all
        ? `연동 생성: ${name} — 모든 업장(앞으로 생길 업장 포함) 조회 가능. 지점 코드 연결은 선택 사항입니다`
        : `연동 생성: ${name}. 이어서 api-client-map 으로 업장과 지점 코드를 연결하세요`);
      printKey(key);
      break;
    }
    case 'api-client-scope': {
      const c = await apiClient(args[0]);
      if (!['all', 'mapped'].includes(args[1])) throw new Error('사용법: api-client-scope <이름> all|mapped');
      await pool.query('UPDATE api_clients SET all_workplaces = $1 WHERE id = $2', [args[1] === 'all', c.id]);
      console.log(args[1] === 'all' ? `${c.name}: 모든 업장 조회로 바꿨습니다` : `${c.name}: 지점 코드로 연결한 업장만 조회로 바꿨습니다`);
      break;
    }
    case 'api-client-rotate': {
      const c = await apiClient(args[0]);
      const key = newApiKey();
      await pool.query('UPDATE api_clients SET key_hash = $1, key_prefix = $2, active = true WHERE id = $3', [keyHash(key), key.slice(0, 12), c.id]);
      console.log(`${c.name} 키를 재발급했습니다. 기존 키는 바로 쓸 수 없습니다`);
      printKey(key);
      break;
    }
    case 'api-client-revoke': {
      const c = await apiClient(args[0]);
      await pool.query('UPDATE api_clients SET active = false WHERE id = $1', [c.id]);
      console.log(`${c.name} 연동을 중지했습니다 (다시 쓰려면 api-client-rotate)`);
      break;
    }
    case 'api-client-map': {
      const [name, workplaceId, branch] = args;
      if (!workplaceId || !branch) throw new Error('사용법: api-client-map <이름> <업장 id> <지점 코드>');
      const c = await apiClient(name);
      const { rows: [w] } = await pool.query('SELECT hotel_name, name FROM workplaces WHERE id = $1', [workplaceId]);
      if (!w) throw new Error('업장 id가 없습니다. workplaces 명령으로 확인하세요');
      await pool.query(
        `INSERT INTO api_client_workplaces (client_id, workplace_id, branch_code) VALUES ($1, $2, $3)
         ON CONFLICT (client_id, workplace_id) DO UPDATE SET branch_code = EXCLUDED.branch_code`,
        [c.id, workplaceId, branch],
      );
      console.log(`${c.name}: ${w.hotel_name} · ${w.name} ↔ 지점 ${branch}`);
      break;
    }
    case 'api-client-unmap': {
      const c = await apiClient(args[0]);
      const { rowCount } = await pool.query('DELETE FROM api_client_workplaces WHERE client_id = $1 AND branch_code = $2', [c.id, args[1]]);
      console.log(rowCount ? `지점 ${args[1]} 연결을 해제했습니다` : '해당 지점 코드가 없습니다');
      break;
    }
    case 'api-clients': {
      const { rows } = await pool.query(
        `SELECT c.name, c.key_prefix, c.active, c.all_workplaces, c.last_used_at, m.branch_code, w.hotel_name, w.name AS workplace
           FROM api_clients c LEFT JOIN api_client_workplaces m ON m.client_id = c.id LEFT JOIN workplaces w ON w.id = m.workplace_id
          ORDER BY c.name, m.branch_code`,
      );
      console.table(rows.map((r) => ({
        연동: r.name, 키: `${r.key_prefix}…`, 상태: r.active ? '사용' : '중지', 범위: r.all_workplaces ? '모든 업장' : '연결한 지점만', 마지막호출: r.last_used_at?.toISOString() || '-',
        지점코드: r.branch_code || '-', 업장: r.workplace ? `${r.hotel_name} · ${r.workplace}` : '-',
      })));
      break;
    }
    default:
      console.log('명령: workplaces | create-workplace | issue-code | make-admin | db-user-add | db-user-remove | db-users | '
        + 'api-client-add | api-client-scope | api-client-map | api-client-unmap | api-client-rotate | api-client-revoke | api-clients');
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
