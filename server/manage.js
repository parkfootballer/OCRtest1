// 업장 관리 명령 (서버 관리자용)
//   node --env-file=.env manage.js workplaces                       업장 목록
//   node --env-file=.env manage.js create-workplace <호텔명> <업장명>  업장을 만들고 가입 코드 발급
//   node --env-file=.env manage.js issue-code <업장 id> [유효일수] [최대 사용 횟수]
//   node --env-file=.env manage.js make-admin <이메일>               같은 업장의 관리자로 지정
// 서버를 한 번 이상 실행해 schema.sql이 적용된 DB에서 쓴다.
const { Pool } = require('pg');
const { generateCode } = require('./codes');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});
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
        `SELECT w.id, w.hotel_name, w.name, count(u.id)::int AS members FROM workplaces w
           LEFT JOIN users u ON u.workplace_id = w.id GROUP BY w.id ORDER BY w.hotel_name, w.name`,
      );
      console.table(rows);
      break;
    }
    case 'create-workplace': {
      const [hotel, name] = args;
      if (!hotel || !name) throw new Error('사용법: create-workplace <호텔명> <업장명>');
      const { rows } = await pool.query('INSERT INTO workplaces (hotel_name, name) VALUES ($1, $2) RETURNING id', [hotel, name]);
      const code = await issue(rows[0].id);
      console.log(`업장 생성: ${hotel} / ${name} (${rows[0].id})`);
      console.log(`가입 코드: ${fmtCode(code.code)}  — 이 코드로 처음 가입한 사람은 일반 회원입니다. 관리자로 바꾸려면 make-admin`);
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
      const { rowCount } = await pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [String(args[0] || '').toLowerCase()]);
      console.log(rowCount ? '관리자로 지정했습니다' : '해당 이메일의 회원이 없습니다');
      break;
    }
    default:
      console.log('명령: workplaces | create-workplace | issue-code | make-admin');
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
