// 서비스 워커: 앱 셸은 미리 캐시해 즉시 열리게 하고, OCR 엔진·한국어 모델(CDN)은 한 번 받으면 재사용한다.
// 앱 파일을 바꿨다면 VERSION을 올려야 휴대폰에 새 버전이 반영된다.
const VERSION = 'v8'; // v8: 업장코드 가입·가입 승인
const SHELL = `shell-${VERSION}`;
const OCR_CACHE = 'ocr-assets-v2'; // v2: Tesseract → PaddleOCR 모델(/models/)

const SHELL_FILES = [
  '/', '/index.html', '/manifest.webmanifest',
  '/css/style.css',
  '/js/paddle.js', '/js/db.js', '/js/policy.js', '/js/parser.js', '/js/ocr.js', '/js/scanner.js', '/js/app.js',
  '/icons/icon-192.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png',
];
const OCR_HOSTS = ['cdn.jsdelivr.net'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k !== SHELL && k !== OCR_CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // API·이미지는 항상 서버에서 (로그인·최신 데이터)
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;

  // OCR 엔진·언어 데이터: 캐시 우선 (용량이 커서 매번 받지 않는다)
  if (OCR_HOSTS.includes(url.hostname) || (url.origin === location.origin && url.pathname.startsWith('/models/'))) {
    e.respondWith(caches.open(OCR_CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // 앱 셸: 네트워크 우선, 오프라인이면 캐시
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
        return res;
      } catch {
        return (await caches.match(req)) || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error());
      }
    })());
  }
});
