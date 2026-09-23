import type { ReactNode } from "react";

/**
 * Пара «метка — значение» для экранов детали (журнал). Практики читаемости, ради которых
 * компонент появился (23.09.2026, жалоба пользователя на «неровный текст»):
 *
 * - двухколоночная сетка с фиксированной колонкой меток: все значения начинаются на одной
 *   вертикали — глаз сканирует колонку сверху вниз, а не прыгает к рваному правому краю;
 * - значения и пояснения выровнены ВЛЕВО: многострочный текст с правым выравниванием
 *   (как было) даёт рваное начало каждой строки и читается с трудом;
 * - tabular-nums: цифры моноширинные, цены не «пляшут» по ширине;
 * - тонкие разделители строк (divide-y у DetailList) вместо голых отступов — ровный
 *   вертикальный ритм, как в списках iOS.
 */
export function DetailList({ children }: { children: ReactNode }) {
  return <dl className="divide-y divide-line/70">{children}</dl>;
}

export function DetailRow({
  label,
  value,
  hint,
  hintTone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  hintTone?: "positive" | "negative";
}) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-baseline gap-x-3 py-2 first:pt-0 last:pb-0">
      <dt className="text-xs leading-5 text-muted">{label}</dt>
      <dd className="min-w-0">
        <div className="text-sm leading-5 text-ink tabular-nums">{value}</div>
        {hint && (
          <p
            className={`mt-0.5 text-[11px] leading-4 ${
              hintTone === "positive"
                ? "text-positive"
                : hintTone === "negative"
                  ? "text-negative"
                  : "text-muted"
            }`}
          >
            {hint}
          </p>
        )}
      </dd>
    </div>
  );
}
