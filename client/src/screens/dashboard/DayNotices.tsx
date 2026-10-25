import type { DayNotice } from "../../api/types";

/**
 * Уведомления сегодняшнего дня над формой открытия (просьба пользователя от 25.10.2026):
 * день недели с одним стопом (правило #16) и час, который вот-вот откроется после ручной
 * блокировки. Текст целиком приходит с сервера (risk/dayNotices.ts) — здесь только вид.
 *
 * Скрыть их нельзя НАМЕРЕННО: это не оповещение «посмотрел и закрыл», а условие дня, и
 * висеть оно должно ровно до сброса дня. Поэтому ни крестика, ни кнопки «понятно».
 *
 * Геометрия повторяет карточку уровня и кнопку паузы: px-4 py-2.5, кружок иконки h-9 w-9,
 * gap-3 — единая стилистика дашборда.
 */

const ICONS: Record<DayNotice["tone"], string> = { warn: "🗓", info: "🔓" };

const TONES: Record<DayNotice["tone"], { card: string; icon: string; title: string; detail: string }> = {
  warn: {
    card: "border-amber-200 bg-amber-50",
    icon: "bg-amber-100",
    title: "text-amber-800",
    detail: "text-amber-700",
  },
  info: {
    card: "border-line bg-card",
    icon: "bg-surface",
    title: "text-ink",
    detail: "text-slate-500",
  },
};

export function DayNotices({ notices }: { notices: DayNotice[] }) {
  if (notices.length === 0) return null;

  return (
    <div className="mx-4 flex flex-col gap-2">
      {notices.map((notice) => {
        const tone = TONES[notice.tone] ?? TONES.info;
        return (
          <div
            key={notice.id}
            className={`flex items-center gap-3 rounded-2xl border px-4 py-2.5 shadow-sm ${tone.card}`}
          >
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg leading-none ${tone.icon}`}
              aria-hidden="true"
            >
              {ICONS[notice.tone] ?? ICONS.info}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className={`text-sm font-medium ${tone.title}`}>{notice.title}</span>
              <span className={`text-[11px] leading-tight ${tone.detail}`}>{notice.detail}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
