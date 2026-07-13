import type { ReactElement } from "react";
import { NavLink } from "react-router-dom";

type TabDefinition = {
  to: string;
  label: string;
  icon: (active: boolean) => ReactElement;
};

function iconStroke(active: boolean) {
  return active ? "#22D3EE" : "#64748B";
}

const tabs: TabDefinition[] = [
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

export function BottomNav() {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-10 border-t border-slate-800 bg-surface/95 backdrop-blur"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto flex max-w-md justify-around">
        {tabs.map((tab) => (
          <li key={tab.to} className="flex-1">
            <NavLink
              to={tab.to}
              end={tab.to === "/"}
              className="flex flex-col items-center gap-1 py-2.5 text-xs"
            >
              {({ isActive }) => (
                <>
                  {tab.icon(isActive)}
                  <span className={isActive ? "text-accent" : "text-slate-500"}>{tab.label}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
