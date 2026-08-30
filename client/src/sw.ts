/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare let self: ServiceWorkerGlobalScope;

/**
 * Собственный service worker вместо сгенерированного (strategies: "injectManifest"
 * в vite.config.ts): кэширование то же, что давал generateSW, плюс обработка Web Push —
 * уведомление «Сделка закрыта» приходит, даже когда приложение не открыто
 * (на iPhone — только если PWA добавлено на экран «Домой», iOS 16.4+).
 */

// Поведение прежнего registerType: "autoUpdate" — новая версия активируется сразу.
self.skipWaiting();
clientsClaim();

// Кэшируем только статику приложения (app shell). API-запросы всегда идут в сеть —
// торговые данные не должны отдаваться из кэша.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), { denylist: [/^\/api\//] }),
);

type PushPayload = {
  title?: string;
  body?: string;
};

self.addEventListener("push", (event) => {
  let payload: PushPayload = {};
  try {
    payload = (event.data?.json() as PushPayload) ?? {};
  } catch {
    // пуш без валидного JSON — покажем заголовок по умолчанию
  }
  const title = payload.title ?? "Сделка закрыта";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body ?? "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      // Звук уведомления системный — свой на iOS задать нельзя, но default звучит громко.
      silent: false,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => "focus" in client);
      if (existing) {
        return existing.focus();
      }
      return self.clients.openWindow("/");
    }),
  );
});
