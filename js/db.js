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

  // imageUrl에는 촬영한 dataURL이 들어온다 → 서버가 파일로 저장하고 URL을 돌려준다
  function createDocument({ documentType, imageUrl }) {
    return api('POST', '/documents', { documentType, image: imageUrl });
  }

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

  return {
    currentUser, login, signup, logout, authConfig, createDocument, saveExtraction, documentBundle,
    listDocuments, setStatus, logReview, deleteDocument, exportAll, memory,
  };
})();
