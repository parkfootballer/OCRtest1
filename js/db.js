// 서버 API 클라이언트 — 데이터는 PostgreSQL(server/)에 저장된다. app.js가 쓰는 인터페이스는 그대로 유지.
const DB = (() => {
  const BASE = '/api';

  async function api(method, url, body) {
    const res = await fetch(BASE + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `서버 오류 (${res.status})`);
      err.status = res.status;
      // 세션 만료 등 → 앱이 로그인 화면으로 보낸다
      if (res.status === 401 && !url.startsWith('/auth/')) window.dispatchEvent(new Event('auth-required'));
      throw err;
    }
    return data;
  }

  let me;
  async function currentUser() {
    return me || (me = await api('GET', '/me'));
  }

  async function login(email, password) {
    me = await api('POST', '/auth/login', { email, password });
    return me;
  }
  async function signup(fields) {
    me = await api('POST', '/auth/signup', fields);
    return me;
  }
  async function logout() {
    me = null;
    await api('POST', '/auth/logout');
  }
  const authConfig = () => api('GET', '/auth/config');
  // 개인정보 수집·이용 동의 (기존 회원·고지문 변경 시)
  async function agreePrivacy(version) {
    me = await api('POST', '/consents', { privacy: version });
    return me;
  }
  // 회원 탈퇴 (비밀번호 확인)
  async function deleteAccount(password) {
    await api('DELETE', '/me', { password });
    me = null;
  }
  // 가입 코드 확인 → { newWorkplace, hotelName, workplaceName }
  const checkCode = (code) => api('POST', '/auth/check-code', { code });
  // 휴대폰 문자 인증: 인증번호 받기 → { expiresIn }, 확인 → { verificationToken } (가입 때 phoneToken으로 제출)
  const sendPhoneCode = (phone) => api('POST', '/auth/phone/send', { phone });
  const verifyPhoneCode = (phone, code) => api('POST', '/auth/phone/verify', { phone, code });

  // imageUrl에는 촬영한 dataURL이 들어온다 → 서버가 파일로 저장하고 URL을 돌려준다
  // fileHash: 원본 파일 SHA-256 (중복 확인용), duplicateOf: 중복 경고를 보고도 등록할 때의 원본 문서
  function createDocument({ documentType, imageUrl, fileHash, duplicateOf }) {
    return api('POST', '/documents', { documentType, image: imageUrl, fileHash, duplicateOf });
  }

  // ---- 중복 확인 ----
  const checkFileDuplicates = (fileHash) => api('POST', '/duplicates/check', { fileHash });
  const documentDuplicates = (documentId) => api('GET', `/documents/${documentId}/duplicates`);
  // decision: 'duplicate'(재고 미반영) | 'distinct'(별개 문서) | null
  const setDuplicate = (documentId, decision, duplicateOf) =>
    api('PATCH', `/documents/${documentId}`, { duplicateDecision: decision, duplicateOf: duplicateOf || null });

  // 최초 OCR 결과 (학습 데이터용)
  const saveOcrResult = (documentId, payload) => api('POST', `/documents/${documentId}/ocr-results`, payload);

  function saveExtraction(documentId, data, items) {
    return api('PUT', `/documents/${documentId}/extraction`, { data, items });
  }

  async function documentBundle(documentId) {
    try {
      return await api('GET', `/documents/${documentId}`);
    } catch (e) {
      if (/찾을 수 없/.test(e.message)) return null;
      throw e;
    }
  }

  function listDocuments() {
    return api('GET', '/documents');
  }

  function setStatus(documentId, status, patch = {}) {
    const { imageUrl, ...rest } = patch;
    const body = { ...rest, status };
    if (imageUrl && imageUrl.startsWith('data:')) body.image = imageUrl; // 재촬영
    return api('PATCH', `/documents/${documentId}`, body);
  }

  async function logReview(entry) {
    const [saved] = await api('POST', `/documents/${entry.documentId}/review-logs`, { entries: [entry] });
    return saved;
  }

  // 삭제 결과: { revertedItems: [재고에서 되돌린 품목], promotedDocumentId }
  function deleteDocument(documentId) {
    return api('DELETE', `/documents/${documentId}`);
  }

  function exportAll() {
    return api('GET', '/export');
  }

  // 거래처 기억: 검수 확정된 상호·고객명 목록 → 인식 오타 보정에 쓴다
  function memory() {
    return api('GET', '/memory');
  }

  // ---- 업장 ----
  const workplace = () => api('GET', '/workplace');
  async function updateWorkplace(fields) {
    me = await api('PATCH', '/workplace', fields);
    return me;
  }
  const issueCode = (opts) => api('POST', '/workplace/codes', opts);
  const deleteCode = (id) => api('DELETE', `/workplace/codes/${id}`);
  // OCR 학습 데이터 활용 동의(선택): agree=false면 철회 + 모은 학습 데이터 파기
  const setTrainingConsent = (agree, version) => api('PUT', '/workplace/training-consent', { agree, version });
  const setMemberRole = (id, role) => api('PATCH', `/workplace/members/${id}`, { role });
  const accessLogs = () => api('GET', '/workplace/access-logs');

  // ---- 재고 ----
  const inventory = () => api('GET', '/inventory');
  const inventoryItem = (id) => api('GET', `/inventory/${id}`);

  return {
    currentUser, login, signup, logout, authConfig, checkCode, sendPhoneCode, verifyPhoneCode, createDocument, saveExtraction, documentBundle,
    listDocuments, setStatus, logReview, deleteDocument, exportAll, memory,
    checkFileDuplicates, documentDuplicates, setDuplicate, saveOcrResult,
    workplace, updateWorkplace, issueCode, deleteCode, inventory, inventoryItem,
    agreePrivacy, deleteAccount, setTrainingConsent, setMemberRole, accessLogs,
  };
})();
