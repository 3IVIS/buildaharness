/* Service worker for Email (U9). It caches the app shell ONLY and never any mail content: a request is cacheable only when it is a same-origin GET
 * for a static build asset. Anything else (mail provider APIs, tokens, /api, the model proxy, navigations to message data) goes straight to the
 * network and is never stored. */
var SHELL_CACHE = 'aielia-email-shell-v1'
var SHELL_URLS = ['/email', '/favicon.svg', '/email.webmanifest']
var STATIC_PATH = /^\/(assets\/[^?]+\.(js|css|woff2?|svg|png)|favicon\.svg|apple-touch-icon\.png|email\.webmanifest)$/

function isShellRequest(request, origin) {
  if (request.method !== 'GET') return false
  var url = new URL(request.url)
  if (url.origin !== origin) return false
  if (url.search) return false
  return url.pathname === '/email' || STATIC_PATH.test(url.pathname)
}

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(SHELL_CACHE).then(function (c) { return c.addAll(SHELL_URLS) }))
})

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== SHELL_CACHE }).map(function (k) { return caches.delete(k) }))
  }))
})

self.addEventListener('fetch', function (event) {
  var request = event.request
  if (!isShellRequest(request, self.location.origin)) return // not ours: the browser handles it, nothing is cached
  event.respondWith(caches.match(request).then(function (hit) {
    if (hit) return hit
    return fetch(request).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(SHELL_CACHE).then(function (c) { c.put(request, copy) }) }
      return res
    })
  }))
})
