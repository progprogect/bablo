import { NavLink } from "react-router-dom";
import { navTabs } from "./navTabs";

/**
 * Нижняя навигация — только на мобильных экранах (на десктопе её роль играет SideNav).
 *
 * НЕ `position: fixed` (правка 18.10.2026): панель — обычный элемент потока, последняя
 * строка флекс-оболочки (App.tsx), а прокручивается контейнер над ней. Сначала (04.10.2026)
 * у панели убрали `backdrop-filter` — он в WKWebView кладёт `fixed`-элемент в слой, который
 * не обновляется во время инерционного скролла, и панель оставалась висеть посреди экрана.
 * Это помогло не до конца: сам по себе `fixed` над скроллящимся документом на iPhone
 * продолжал отрываться. В потоке отрываться нечему — панель физически часть разметки.
 *
 * Фон остаётся непрозрачным: прозрачности было 5% (`bg-surface/95`), размывать на таком
 * фоне нечего, а возвращать `backdrop-filter` ради этого незачем.
 */
export function BottomNav() {
  return (
    <nav
      className="shrink-0 border-t border-line bg-surface md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {/* h-16 фиксирует высоту панели. Отступ контента под неё больше не нужен: панель
          занимает собственную строку оболочки, а не лежит поверх списка. */}
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
