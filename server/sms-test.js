// 문자 발송 진단: 서버와 같은 코드(sms.js)로 시험 문자 한 통을 보내고, 실패하면 업체가 알려 준 이유를 그대로 보여 준다.
//   SMS_PROVIDER=solapi SOLAPI_API_KEY=… SOLAPI_API_SECRET=… SMS_FROM=… node sms-test.js 01012345678
// Windows에서는 키를 화면에 남기지 않는 sms-test.ps1 로 실행하는 것을 권장
const sms = require('./sms');

const to = String(process.argv[2] || '').replace(/\D/g, '');
const from = String(process.env.SMS_FROM || '').replace(/\D/g, '');
const key = process.env.SOLAPI_API_KEY || '';

console.log('--- 설정 확인 (값은 일부만 표시)');
console.log(`업체(SMS_PROVIDER): ${process.env.SMS_PROVIDER || '(없음)'}`);
console.log(`API Key: ${key ? `${key.slice(0, 4)}…${key.slice(-2)} (${key.length}자${key.length === 16 ? '' : ' — 솔라피 키는 16자입니다'})` : '(없음)'}`);
console.log(`API Secret: ${process.env.SOLAPI_API_SECRET ? `${process.env.SOLAPI_API_SECRET.length}자` : '(없음)'}`);
console.log(`발신번호(SMS_FROM): ${from || '(없음)'}`);
console.log(`받는 번호: ${to || '(없음)'}`);
if (/\s/.test(key) || /\s/.test(process.env.SOLAPI_API_SECRET || '')) console.log('⚠ 키 앞뒤에 공백·줄바꿈이 섞여 있습니다. 다시 복사하세요');
if (!/^01[016789]\d{7,8}$/.test(to)) { console.log('받는 번호를 010으로 시작하는 휴대폰 번호로 넣으세요'); process.exit(1); }
if (!sms.configured()) { console.log('설정이 부족합니다 (SMS_PROVIDER·키·SMS_FROM 모두 필요)'); process.exit(1); }

console.log('--- 시험 문자 발송');
sms.sendSms(to, '[찰칵장부] 문자 발송 시험입니다').then(
  () => console.log('✅ 성공: 솔라피가 문자를 접수했습니다. 휴대폰을 확인하세요. 이 설정 그대로 Render에 넣으면 됩니다'),
  (e) => {
    console.log(`❌ 실패: ${e.message}`);
    const m = e.message;
    const hint = [
      [/InvalidApiKey|apiKey/i, 'API Key가 틀렸거나 삭제된 키입니다. 솔라피 콘솔에서 키를 다시 확인하세요'],
      [/Signature|InvalidSignature|HMAC/i, 'API Secret이 틀렸습니다 (Key와 짝이 맞는 Secret인지 확인)'],
      [/Balance|잔액|포인트|Point/i, '잔액이 부족합니다. 솔라피 콘솔에서 충전하세요'],
      [/From|발신번호|1062|SenderId/i, '발신번호가 등록·승인되지 않았습니다. 솔라피 콘솔 → 발신번호 관리에서 승인 상태를 확인하세요'],
      [/IP|Forbidden|403/i, 'API Key에 허용 IP 제한이 걸려 있을 수 있습니다. 솔라피 API Key 설정에서 IP 제한을 풀거나 서버 IP를 추가하세요'],
      [/fetch failed|ENOTFOUND|ECONN|ETIMEDOUT/i, '솔라피 서버에 연결하지 못했습니다 (인터넷·방화벽 확인)'],
    ].find(([re]) => re.test(m));
    if (hint) console.log(`👉 ${hint[1]}`);
    process.exitCode = 1;
  },
);
