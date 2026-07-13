import { Route, Routes } from "react-router-dom";
import { AuthGate } from "./auth/AuthGate";
import { BottomNav } from "./components/BottomNav";
import { Dashboard } from "./screens/Dashboard";
import { History } from "./screens/History";
import { Admin } from "./screens/Admin";

export default function App() {
  return (
    <div className="flex min-h-screen flex-col pb-16">
      <AuthGate>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/history" element={<History />} />
          <Route path="/admin" element={<Admin />} />
        </Routes>
        <BottomNav />
      </AuthGate>
    </div>
  );
}
