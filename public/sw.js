/* Kaka service worker — receives push reminders. No caching: the app itself
 * stays network-served so deploys are picked up normally. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = { title: "Kaka", body: "You have a reminder." };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* unparseable payload — show the generic reminder */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body || "",
      tag: data.tag || undefined,
      icon: "/favicon.svg",
      badge: "/favicon.svg",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const open = clients.find((c) => "focus" in c);
      if (open) {
        if (url !== "/" && "navigate" in open) open.navigate(url);
        return open.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
