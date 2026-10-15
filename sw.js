// Оболочку приложения держим в кэше, чтобы открывалось без связи.
// Прайс сюда не попадает: его app.js сам кэширует в localStorage.
const CACHE = 'smeta-v12';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icon.svg', 'icon-192.png', 'logo.jpg', 'vendor/pdfmake.min.js', 'vendor/vfs_fonts.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('.csv')) return;
  // Сначала сеть, чтобы правки приложения доходили сразу; кэш — когда сети нет
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
