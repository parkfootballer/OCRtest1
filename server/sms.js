// 문자(SMS) 발송. SMS_PROVIDER 환경변수로 업체를 고른다.
//   solapi  — 솔라피(국내): SOLAPI_API_KEY, SOLAPI_API_SECRET, SMS_FROM(사전 등록한 발신번호)
//   twilio  — Twilio(해외): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SMS_FROM
//   console — 개발용: 실제로 보내지 않고 서버 로그에 인증번호를 찍는다
// 설정하지 않으면 개발 환경에서는 console, 운영(NODE_ENV=production)에서는 발송 불가로 처리한다.
const crypto = require('node:crypto');

const PROVIDER = process.env.SMS_PROVIDER || (process.env.NODE_ENV === 'production' ? '' : 'console');
const FROM = String(process.env.SMS_FROM || '').replace(/\D/g, '');

// 공식 SDK(solapi-nodejs)와 같은 방식: HMAC-SHA256(date + salt) 서명, messages/v4/send-many/detail 로 발송
async function sendSolapi(to, text) {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString('hex'); // 32자
  const signature = crypto.createHmac('sha256', process.env.SOLAPI_API_SECRET).update(date + salt).digest('hex');
  const res = await fetch('https://api.solapi.com/messages/v4/send-many/detail', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `HMAC-SHA256 apiKey=${process.env.SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${signature}`,
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
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const intl = (n) => (n.startsWith('0') ? `+82${n.slice(1)}` : `+${n}`); // 국내 번호 → 국제 형식
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: intl(to), From: intl(FROM), Body: text }),
  });
  if (!res.ok) throw new Error(`twilio ${res.status} ${await res.text().catch(() => '')}`);
}

const configured = () => PROVIDER === 'console' || (['solapi', 'twilio'].includes(PROVIDER) && !!FROM);
const isConsole = () => PROVIDER === 'console';

async function sendSms(to, text) {
  if (PROVIDER === 'console') return console.log(`[SMS 개발용] ${to}: ${text}`);
  if (PROVIDER === 'solapi') return sendSolapi(to, text);
  if (PROVIDER === 'twilio') return sendTwilio(to, text);
  throw new Error('SMS_PROVIDER가 설정되지 않았습니다');
}

module.exports = { sendSms, configured, isConsole, PROVIDER };
