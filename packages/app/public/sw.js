// Notifications only: no fetch handler, so the app is never served from a cache here.
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const { tag, data } = event.notification
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows[0]
      if (!open) return self.clients.openWindow(data?.url ?? "/")
      open.postMessage({ type: "notification-click", tag })
      return open.focus()
    }),
  )
})
