// 오답노트 앱 설치용 서비스 워커
// 화면 파일은 항상 새 버전을 먼저 받고(GitHub에 올린 수정이 바로 반영), 인터넷이 끊겼을 때만 저장본을 씀.
// 로그인·데이터·AI 서버 요청은 건드리지 않음.
const CACHE = 'odap-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
