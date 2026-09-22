import { Link, useLocation } from "react-router-dom";

/**
 * Нижняя навигация журнала — два раздела (решение пользователя от 23.09.2026):
 * «Разбор» (лента сделок и деталь) и «Анализ» (таблицы по категориям; конструктор
 * категорий — по шестерёнке внутри «Анализа»). Геометрия — как BottomNav терминала,
 * цвета — токенами темы (в журнале это палитра iOS).
 */
export function JournalNav() {
  const { pathname } = useLocation();
  // Деталь сделки принадлежит «Разбору», таблица и настройки — «Анализу».
  const reviewActive = pathname === "/" || pathname.startsWith("/trades");
  const analysisActive = pathname.startsWith("/analysis") || pathname.startsWith("/settings");

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface/95 backdrop-blur"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto flex h-16 max-w-md items-center justify-around">
        <NavItem to="/" label="Разбор" active={reviewActive} icon={<ReviewIcon />} />
        <NavItem to="/analysis" label="Анализ" active={analysisActive} icon={<AnalysisIcon />} />
      </ul>
    </nav>
  );
}

function NavItem({ to, label, active, icon }: { to: string; label: string; active: boolean; icon: React.ReactNode }) {
  return (
    <li className="flex-1">
      <Link
        to={to}
        className={`flex flex-col items-center gap-1 py-2.5 text-xs ${active ? "text-accent" : "text-muted"}`}
      >
        {icon}
        <span>{label}</span>
      </Link>
    </li>
  );
}

/** Карточка с галочкой — разбор сделок. stroke="currentColor": цвет задаёт класс ссылки. */
function ReviewIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <rect x="4" y="4" width="16" height="16" rx="3.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="m8.5 12 2.4 2.4 4.6-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Колонки таблицы — анализ по категориям. */
function AnalysisIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M5 19V10M12 19V5M19 19v-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
