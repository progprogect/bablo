import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Свой sw.ts вместо сгенерированного: то же кэширование + обработчики Web Push
      // (уведомление «Сделка закрыта» на устройство). См. src/sw.ts.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      includeAssets: ["favicon.png"],
      // Манифесты обеих PWA — статические файлы в public/ (manifest.webmanifest — терминал,
      // journal.webmanifest — «Bablo.Дневник»), а <link rel="manifest"> стоит в каждом html
      // руками. Автогенерация выключена: она вставляла бы ОДИН манифест во все html, и у
      // journal.html оказалось бы два конфликтующих манифеста.
      manifest: false,
      injectManifest: {
        // Пречекэш только статики приложения (app shell); стратегия обхода API —
        // внутри src/sw.ts (NavigationRoute с denylist /api).
        globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
      },
    }),
  ],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      // Две точки входа: терминал (index.html) и журнал разбора сделок (journal.html) —
      // отдельные PWA на одном origin с общим service worker (см. src/sw.ts).
      input: {
        main: path.resolve(__dirname, "index.html"),
        journal: path.resolve(__dirname, "journal.html"),
      },
    },
  },
});
