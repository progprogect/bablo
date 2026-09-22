import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./journal.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Все токены — через CSS-переменные (RGB-триплеты, чтобы работали alpha-модификаторы
        // вроде bg-surface/95). Значения задаются в src/index.css: :root — палитра терминала
        // (тёплый айвори в духе BingX light), .theme-journal — палитра журнала в духе iOS.
        // Классы (bg-surface, text-ink и т.д.) одни и те же в обоих приложениях — темы
        // отличаются только значениями переменных, поэтому компоненты остаются общими.
        surface: "rgb(var(--surface-rgb) / <alpha-value>)",
        card: "rgb(var(--card-rgb) / <alpha-value>)",
        line: "rgb(var(--line-rgb) / <alpha-value>)",
        ink: "rgb(var(--ink-rgb) / <alpha-value>)",
        accent: "rgb(var(--accent-rgb) / <alpha-value>)",
        // Смысловые цвета результата (прибыль/убыток) и вторичного текста. Терминал
        // исторически использует готовые классы Tailwind (emerald-600/red-600/slate-500)
        // напрямую — их не трогаем; токены нужны журналу, где эти же роли исполняют
        // системные цвета iOS (systemGreen/systemRed/secondaryLabel).
        positive: "rgb(var(--positive-rgb) / <alpha-value>)",
        negative: "rgb(var(--negative-rgb) / <alpha-value>)",
        muted: "rgb(var(--muted-rgb) / <alpha-value>)",
      },
      spacing: {
        // Нижний отступ контента под фиксированной мобильной навигацией (BottomNav):
        // её высота (h-16) + safe-area iPhone (home indicator) + небольшой запас, чтобы
        // последняя карточка и кнопка "Показать ещё" не липли к панели и не уходили
        // под неё (тап иначе перехватывает nav). Единый источник правды для отступа.
        "bottom-nav": "calc(4rem + env(safe-area-inset-bottom) + 0.75rem)",
      },
    },
  },
  plugins: [],
} satisfies Config;
