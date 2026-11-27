/**
 * ADR 0033 §2.6: the service worker that shows a pushed notification and opens its page when it is tapped. It holds no
 * state and knows nothing of the business: the push carries a title, a sentence and a path of the product, which opens
 * signed in or at the sign-in page. Served from the client host's root so its scope is the whole app.
 */
const SOURCE = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = typeof data.title === 'string' ? data.title : 'INRP2P';
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/exchange';
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body : '',
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    icon: '/apple-icon.png',
    badge: '/apple-icon.png',
    data: { url },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/exchange', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
        w.navigate(url);
        return w.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
`;

export function GET(): Response {
  return new Response(SOURCE, {
    headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache', 'service-worker-allowed': '/' },
  });
}
