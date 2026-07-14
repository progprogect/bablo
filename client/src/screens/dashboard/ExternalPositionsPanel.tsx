import type { ExternalPosition } from "../../api/types";
import { formatPrice, formatSignedUsd } from "../../lib/format";

/**
 * Позиции, открытые на BingX не через приложение (вручную на бирже) — без SL/TP/riskUsd,
 * известных нам, поэтому карточка read-only: риск-движок ими не управляет. Показываем,
 * чтобы пользователь не остался в неведении, и явно объясняем, почему форма открытия
 * новой сделки скрыта (сервер её тоже блокирует, см. checkCanOpenTrade).
 */
export function ExternalPositionsPanel({ positions }: { positions: ExternalPosition[] }) {
  if (positions.length === 0) return null;

  return (
    <div className="mx-4 flex flex-col gap-3">
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
        {positions.length > 1
          ? "На BingX открыто несколько позиций не через приложение — новую сделку нельзя открыть, пока они не закрыты."
          : "На BingX открыта позиция не через приложение — новую сделку нельзя открыть, пока она не закрыта."}
      </p>

      {positions.map((position) => {
        const pnlColorClass =
          position.unrealizedProfit === null
            ? "text-slate-500"
            : position.unrealizedProfit > 0
              ? "text-emerald-600"
              : position.unrealizedProfit < 0
                ? "text-red-600"
                : "text-slate-500";

        return (
          <div
            key={position.symbol}
            className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-baseline gap-2">
                <h3 className="text-base font-medium text-ink">
                  {position.symbol.replace(/-USDT$/, "")}
                </h3>
                <span className={`text-sm font-semibold ${pnlColorClass}`}>
                  {formatSignedUsd(position.unrealizedProfit)}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span
                  className={
                    position.side === "long"
                      ? "rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700"
                      : "rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-700"
                  }
                >
                  {position.side === "long" ? "Лонг" : "Шорт"}
                </span>
                <span className="text-xs text-slate-400">{position.leverage}x</span>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <Row label="Вход" value={formatPrice(position.entryPrice)} />
              <Row label="Объём" value={String(position.quantity)} />
              <Row label="Ликвидация" value={formatPrice(position.liquidationPrice)} />
            </dl>

            <p className="text-xs text-slate-400">
              Открыта вне приложения — SL/TP и риск-план ей не назначены.
            </p>
          </div>
        );
      })}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}
