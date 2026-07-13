import type { ReactElement } from "react";

export type TabDefinition = {
  to: string;
  label: string;
  icon: (active: boolean) => ReactElement;
};

export function iconStroke(active: boolean): string {
  return active ? "#2F6FED" : "#94A3B8";
}

/** Единый источник разделов навигации — используется и BottomNav (моб.), и SideNav (десктоп). */
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
  {
    to: "/admin",
    label: "Админка",
    icon: (active) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="3.2" stroke={iconStroke(active)} strokeWidth="1.8" />
        <path
          d="M12 4v2.2M12 17.8V20M4 12h2.2M17.8 12H20M6.3 6.3l1.6 1.6M16.1 16.1l1.6 1.6M6.3 17.7l1.6-1.6M16.1 7.9l1.6-1.6"
          stroke={iconStroke(active)}
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
];
