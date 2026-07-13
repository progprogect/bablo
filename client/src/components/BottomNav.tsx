import { NavLink } from "react-router-dom";
import { navTabs } from "./navTabs";

/** Нижняя навигация — только на мобильных экранах (на десктопе её роль играет SideNav). */
export function BottomNav() {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface/95 backdrop-blur md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto flex max-w-md justify-around">
        {navTabs.map((tab) => (
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
