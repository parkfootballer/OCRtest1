// 서비스 워커 등록 (CSP가 인라인 스크립트를 막으므로 파일로 둔다)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(console.warn));
}
