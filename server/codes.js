// 업장 가입 코드: 헷갈리는 글자(0/O, 1/I/L)를 뺀 대문자·숫자 8자. 화면에는 ABCD-EFGH 로 보여 준다
const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateCode(len = 8) {
  let s = '';
  for (const b of crypto.randomBytes(len)) s += ALPHABET[b % ALPHABET.length];
  return s;
}
// 입력값 정규화: 소문자·하이픈·공백 허용
const normCode = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
// 호텔명·업장명 비교 키 — DB의 workplaces.hotel_key / name_key 와 같은 규칙
const nameKey = (s) => String(s || '').replace(/\s/g, '').toLowerCase();

module.exports = { generateCode, normCode, nameKey };
