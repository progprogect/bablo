import { Route, Routes } from "react-router-dom";
import { AuthGate } from "./auth/AuthGate";
import { BottomNav } from "./components/BottomNav";
import { SideNav } from "./components/SideNav";
import { Dashboard } from "./screens/Dashboard";
import { History } from "./screens/History";
import { Admin } from "./screens/Admin";

export default function App() {
  return (
    <div className="min-h-screen bg-surface">
      <AuthGate>
        <div className="mx-auto flex min-h-screen w-full max-w-5xl md:items-start">
          <SideNav />
          {/* На мобильном — обычная колонка на всю ширину с отступом под BottomNav.
              На десктопе — центрированная колонка фиксированной ширины рядом с SideNav,
              как в большинстве терминалов: не тянем формы на всю ширину экрана. */}
          <div className="flex w-full flex-1 flex-col pb-16 md:mx-auto md:max-w-md md:pb-10 md:pt-10">
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
