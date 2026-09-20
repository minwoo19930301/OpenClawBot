const appOrigin = self.location.origin;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const safeUrl = (candidate) => {
  try {
    const url = new URL(typeof candidate === "string" ? candidate : "/", appOrigin);
    if (url.origin !== appOrigin) return `${appOrigin}/`;
    if (url.pathname !== "/" && url.pathname !== "/index.html") return `${appOrigin}/`;
    const room = url.searchParams.get("room");
    return room ? `${appOrigin}/?room=${encodeURIComponent(room)}` : `${appOrigin}/`;
  } catch {
    return `${appOrigin}/`;
  }
};

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};
  const title = typeof payload.title === "string" && payload.title.trim()
    ? payload.title
    : "Open Grokbot";
  const options = {
    body: typeof payload.body === "string" ? payload.body : "",
    tag: typeof payload.tag === "string" ? payload.tag : undefined,
    data: { url: safeUrl(payload.url) },
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = safeUrl(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        if ("navigate" in client && client.url !== target) await client.navigate(target);
        await client.focus();
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
