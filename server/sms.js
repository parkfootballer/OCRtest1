// 문자(SMS) 발송. SMS_PROVIDER 환경변수로 업체를 고른다.
//   solapi  — 솔라피(국내): SOLAPI_API_KEY, SOLAPI_API_SECRET, SMS_FROM(사전 등록한 발신번호)
//   twilio  — Twilio(해외): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SMS_FROM
//   console — 개발용: 실제로 보내지 않고 서버 로그에 인증번호를 찍는다
// 설정하지 않으면 개발 환경에서는 console, 운영(NODE_ENV=production)에서는 발송 불가로 처리한다.
const crypto = require('node:crypto');

// 호스팅 화면에 값을 붙여 넣을 때 섞이는 앞뒤 공백·줄바꿈·따옴표를 걷어 낸다 (서명이 틀어지는 흔한 원인)
const env = (name) => String(process.env[name] || '').trim().replace(/^["']|["']$/g, '').trim();

const PROVIDER = env('SMS_PROVIDER').toLowerCase() || (process.env.NODE_ENV === 'production' ? '' : 'console');
const FROM = env('SMS_FROM').replace(/\D/g, '');
const SOLAPI_KEY = env('SOLAPI_API_KEY');
const SOLAPI_SECRET = env('SOLAPI_API_SECRET');
const TWILIO_SID = env('TWILIO_ACCOUNT_SID');
const TWILIO_TOKEN = env('TWILIO_AUTH_TOKEN');

// 공식 SDK(solapi-nodejs)와 같은 방식: HMAC-SHA256(date + salt) 서명, messages/v4/send-many/detail 로 발송
async function sendSolapi(to, text) {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString('hex'); // 32자
  const signature = crypto.createHmac('sha256', SOLAPI_SECRET).update(date + salt).digest('hex');
  const res = await fetch('https://api.solapi.com/messages/v4/send-many/detail', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `HMAC-SHA256 apiKey=${SOLAPI_KEY}, date=${date}, salt=${salt}, signature=${signature}`,
    },
    body: JSON.stringify({ messages: [{ to, from: FROM, text }] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`solapi ${res.status} ${body.errorCode || ''} ${body.errorMessage || ''}`);
  // 미등록 발신번호·잔액 부족 등은 200 응답 안의 failedMessageList로 온다
  const failed = body.failedMessageList || [];
  if (failed.length) throw new Error(`solapi 접수 실패 ${failed.map((f) => `${f.statusCode} ${f.statusMessage}`).join(', ')}`);
}

async function sendTwilio(to, text) {
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const intl = (n) => (n.startsWith('0') ? `+82${n.slice(1)}` : `+${n}`); // 국내 번호 → 국제 형식
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: intl(to), From: intl(FROM), Body: text }),
  });
  if (!res.ok) throw new Error(`twilio ${res.status} ${await res.text().catch(() => '')}`);
}

// 빠진 설정 이름 목록 (비어 있으면 발송 가능)
function missing() {
  if (PROVIDER === 'console') return [];
  if (PROVIDER === 'solapi') return [['SOLAPI_API_KEY', SOLAPI_KEY], ['SOLAPI_API_SECRET', SOLAPI_SECRET], ['SMS_FROM', FROM]].filter(([, v]) => !v).map(([k]) => k);
  if (PROVIDER === 'twilio') return [['TWILIO_ACCOUNT_SID', TWILIO_SID], ['TWILIO_AUTH_TOKEN', TWILIO_TOKEN], ['SMS_FROM', FROM]].filter(([, v]) => !v).map(([k]) => k);
  return [PROVIDER ? `SMS_PROVIDER(알 수 없는 값: ${PROVIDER})` : 'SMS_PROVIDER'];
}
const configured = () => missing().length === 0;
const isConsole = () => PROVIDER === 'console';

// 서버 시작 로그용 요약 — 비밀값은 길이만
function describe() {
  if (PROVIDER === 'console') return '문자: 개발용(console) — 실제로 보내지 않음';
  const m = missing();
  const parts = [`업체=${PROVIDER || '(없음)'}`, `발신번호=${FROM ? `${FROM.slice(0, 3)}****${FROM.slice(-4)}` : '(없음)'}`];
  if (PROVIDER === 'solapi') parts.push(`API Key ${SOLAPI_KEY.length}자${SOLAPI_KEY && SOLAPI_KEY.length !== 16 ? '(솔라피 키는 16자 — 확인 필요)' : ''}`, `Secret ${SOLAPI_SECRET.length}자`);
  return `문자: ${parts.join(', ')}${m.length ? ` → 빠진 설정: ${m.join(', ')} (발송 불가)` : ''}`;
}

async function sendSms(to, text) {
  if (PROVIDER === 'console') return console.log(`[SMS 개발용] ${to}: ${text}`);
  if (!configured()) throw new Error(`문자 설정 부족: ${missing().join(', ')}`);
  if (PROVIDER === 'solapi') return sendSolapi(to, text);
  return sendTwilio(to, text);
}

module.exports = { sendSms, configured, isConsole, describe, missing, PROVIDER };
