// Service worker de GymTrack: permite instalar la app y abrirla sin conexión.
// - Archivos de la app: primero la red (siempre la última versión); si no hay conexión, la copia guardada.
// - Librerías (Chart.js, Supabase, fuentes): copia guardada, se descargan una vez.
// - Datos de Supabase: nunca se guardan aquí (siempre van a la red).
const CACHE = 'gymtrack-v1'
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png']
const CDN = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

function saveCopy(req, res) {
  const copy = res.clone()
  caches.open(CACHE).then((c) => c.put(req, copy))
  return res
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.hostname.endsWith('supabase.co')) return // datos: siempre a la red

  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => (res.ok ? saveCopy(req, res) : res))
        .catch(() => caches.match(req).then((m) => m || caches.match('./index.html')))
    )
  } else if (CDN.includes(url.hostname)) {
    e.respondWith(caches.match(req).then((m) => m || fetch(req).then((res) => saveCopy(req, res))))
  }
})
