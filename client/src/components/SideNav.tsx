import { NavLink } from "react-router-dom";
import { navTabs } from "./navTabs";

/** Вертикальная навигация для десктопа — на мобильных экранах скрыта (см. BottomNav). */
export function SideNav() {
  return (
    <nav className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col gap-1 border-r border-line px-3 py-8 md:flex">
      <div className="mb-6 px-3 text-lg font-semibold text-ink">Bablo</div>
      {navTabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.to === "/"}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors ${
              isActive ? "bg-accent/10 text-accent" : "text-slate-500 hover:bg-slate-100"
            }`
          }
        >
          {({ isActive }) => (
            <>
              {tab.icon(isActive)}
              <span className="font-medium">{tab.label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
