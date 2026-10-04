import { NavLink } from "react-router-dom";
import { navTabs } from "./navTabs";

/**
 * Нижняя навигация — только на мобильных экранах (на десктопе её роль играет SideNav).
 *
 * Фон НЕПРОЗРАЧНЫЙ и без backdrop-blur (правка 04.10.2026). `backdrop-filter` на
 * `position: fixed` в WKWebView (iPhone, standalone-PWA) кладёт панель в слой, который не
 * обновляется во время инерционного скролла: панель остаётся висеть там, где была
 * несколько кадров назад, — посреди экрана, а список продолжается под ней. Прозрачности
 * было 5% (`bg-surface/95`), размывать ей нечего — так что визуально не потеряли ничего,
 * а скролл перестал отрывать панель от низа экрана.
 */
export function BottomNav() {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {/* h-16 фиксирует высоту панели — на неё завязан отступ контента (spacing
          "bottom-nav" в tailwind.config.ts), чтобы низ списка не уходил под навигацию. */}
      <ul className="mx-auto flex h-16 max-w-md items-center justify-around">
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
