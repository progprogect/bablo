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
    <div className="min-h-screen bg-surface">
      <AuthGate>
        <div className="mx-auto flex min-h-screen w-full max-w-5xl md:items-start md:justify-center">
          <div className="flex w-full flex-1 flex-col pb-bottom-nav md:mx-auto md:max-w-md">
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
