import { Route, Routes } from "react-router-dom";
import { AuthGate } from "./auth/AuthGate";
import { BottomNav } from "./components/BottomNav";
import { TradeCloseChime } from "./components/TradeCloseChime";
import { SideNav } from "./components/SideNav";
import { Dashboard } from "./screens/Dashboard";
import { History } from "./screens/History";
import { Admin } from "./screens/Admin";

/**
 * Оболочка приложения ростом ровно в видимую высоту экрана: прокручивается ВНУТРЕННИЙ
 * контейнер с маршрутами, а не документ (правка от 18.10.2026, причины — в index.css).
 *
 * Что это даёт на iPhone:
 * - страница не может быть выше экрана, поэтому «лишнего» скролла под контентом нет;
 * - нижняя панель — обычный элемент потока, а не `position: fixed`: WKWebView больше
 *   нечему перерисовывать с задержкой во время инерционного скролла;
 * - паддинг `safe-area-inset-top` стоит на оболочке, то есть ВНЕ области прокрутки —
 *   контент физически не может наехать на статус-бар.
 *
 * `min-h-0` на флекс-контейнерах обязателен: без него флекс-элемент не даёт себя сжать
 * ниже содержимого, внутренний `overflow-y-auto` не получает ограниченную высоту и
 * прокрутка снова уезжает на документ.
 */
export default function App() {
  return (
    <div
      className="flex h-[100dvh] flex-col overflow-hidden bg-surface"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <AuthGate>
        <TradeCloseChime />
        <div className="mx-auto flex w-full min-h-0 max-w-5xl flex-1">
          <SideNav />
          {/* На мобильном — колонка на всю ширину, она же область прокрутки.
              На десктопе — центрированная колонка фиксированной ширины рядом с SideNav,
              как в большинстве терминалов: не тянем формы на всю ширину экрана.
              `overscroll-contain` — чтобы оттягивание внутри списка не уходило наружу. */}
          <div className="flex w-full min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-3 md:mx-auto md:max-w-md md:pb-10 md:pt-10">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/history" element={<History />} />
              <Route path="/admin" element={<Admin />} />
            </Routes>
          </div>
        </div>
        <BottomNav />
      </AuthGate>
    </div>
  );
}
