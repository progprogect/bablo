import type { ReactElement } from "react";

export type TabDefinition = {
  to: string;
  label: string;
  icon: (active: boolean) => ReactElement;
};

export function iconStroke(active: boolean): string {
  return active ? "#2F6FED" : "#94A3B8";
}

/**
 * Единый источник разделов навигации — используется и BottomNav (моб.), и SideNav (десктоп).
 * Админка сюда намеренно не входит: она доступна только прямым переходом по /admin, без
 * пункта меню — чтобы не было соблазна туда лишний раз заходить (см. docs/PROJECT.md).
 */
export const navTabs: TabDefinition[] = [
  {
    to: "/",
    label: "Дашборд",
    icon: (active) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path
          d="M4 11.5 12 4l8 7.5M6 10v9h12v-9"
          stroke={iconStroke(active)}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    to: "/history",
    label: "История",
    icon: (active) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path
          d="M4 6h16M4 12h16M4 18h10"
          stroke={iconStroke(active)}
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
];
