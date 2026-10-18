import { Route, Routes } from "react-router-dom";
import { AuthGate } from "../auth/AuthGate";
import { JournalNav } from "./components/JournalNav";
import { Review } from "./screens/Review";
import { TradeDetail } from "./screens/TradeDetail";
import { Analysis } from "./screens/Analysis";
import { CategoryTable } from "./screens/CategoryTable";
import { JournalSettings } from "./screens/JournalSettings";

/**
 * Журнал разбора сделок. Изолирован от терминала: ссылок между приложениями нет ни в одну
 * сторону, попасть сюда можно только прямым URL /journal (или с иконки «Bablo.Дневник»).
 * Вход — тот же PIN (сессия одна на origin). Realtime журналу не нужен: он работает
 * с закрытыми сделками, данные обновляются при загрузке экрана.
 */
export function JournalApp() {
  return (
    /* Оболочка и прокрутка — как в терминале (App.tsx, правка 18.10.2026): высота ровно
       в экран, скроллится внутренний контейнер, панель внизу — обычный элемент потока.
       Баг со скроллом на iPhone был общий: разметка у двух приложений одинаковая. */
    <div
      className="flex h-[100dvh] flex-col overflow-hidden bg-surface"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <AuthGate>
        <div className="mx-auto flex w-full min-h-0 max-w-5xl flex-1 md:justify-center">
          <div className="flex w-full min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-3 md:mx-auto md:max-w-md">
            <Routes>
              <Route path="/" element={<Review />} />
              <Route path="/trades/:id" element={<TradeDetail />} />
              <Route path="/analysis" element={<Analysis />} />
              <Route path="/analysis/:id" element={<CategoryTable />} />
              <Route path="/settings" element={<JournalSettings />} />
            </Routes>
          </div>
        </div>
        <JournalNav />
      </AuthGate>
    </div>
  );
}
