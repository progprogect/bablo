import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../../api/http";
import { getOverview } from "../api";
import { plural } from "../plural";
import type { JournalOverview } from "../types";

/**
 * «Анализ»: выбор категории → таблица сделок по её чек-листу. Конструктор категорий —
 * по шестерёнке (решение пользователя от 23.09.2026: два таба, настройки внутри Анализа).
 */
export function Analysis() {
  const [overview, setOverview] = useState<JournalOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getOverview()
      .then(setOverview)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить категории"));
  }, []);

  return (
    <section className="flex flex-1 flex-col gap-4 pt-10 pb-4">
      <div className="flex items-center justify-between px-4">
        <h1 className="text-lg font-medium text-ink">Анализ</h1>
        <Link to="/settings" aria-label="Настройки категорий" className="text-muted">
          <GearIcon />
        </Link>
      </div>

      {error && <p className="px-6 text-center text-sm text-negative">{error}</p>}
      {!error && overview === null && <p className="px-6 text-center text-sm text-muted">Загрузка…</p>}

      {overview !== null && overview.categories.length === 0 && (
        <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
          <p className="text-sm text-ink">Категорий пока нет</p>
          <p className="text-xs text-muted">
            Категория — это тип сетапа или входа со своим чек-листом. Разобранные по ней
            сделки собираются здесь в таблицу для анализа.
          </p>
          <Link to="/settings" className="mt-1 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white">
            Создать категорию
          </Link>
        </div>
      )}

      {overview !== null && overview.categories.length > 0 && (
        <div className="flex flex-col gap-3">
          {overview.categories.map((category) => (
            <Link
              key={category.id}
              to={`/analysis/${category.id}`}
              className="mx-4 flex items-center justify-between rounded-2xl border border-line bg-card p-4 shadow-sm"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-ink">{category.name}</span>
                <span className="text-xs text-muted">
                  {plural(category.tradesCount, "сделка", "сделки", "сделок")} ·{" "}
                  {plural(category.itemsCount, "пункт", "пункта", "пунктов")}
                </span>
              </div>
              <ChevronIcon />
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function GearIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 3.5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M18 6l-1.4 1.4M7.4 16.6 6 18M18 18l-1.4-1.4M7.4 7.4 6 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-muted">
      <path d="m9.5 5 6.5 7-6.5 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
