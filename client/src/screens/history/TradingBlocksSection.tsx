import { useEffect, useState } from "react";
import { ApiError, blockHourRequest, getTradingBlocks, scheduleWindowRequest } from "../../api/client";
import type { TradingBlocks } from "../../api/types";

/**
 * Ручные блокировки торговли («История» → «Настройки», запрос пользователя от 01.10.2026).
 * Пришли на смену правилу убыточных часов: никакой автоматики — пользователь сам закрывает
 * час суток на срок или планирует окно «дата + с … до» (таймзона риск-плана, МСК).
 *
 * Главное свойство: СНЯТЬ блокировку до истечения срока нельзя — ни здесь, ни в API.
 * Поэтому постановка идёт через явное подтверждение, а у каждой активной блокировки
 * показывается только таймер обратного отсчёта до её окончания.
 */

/** Сроки блокировки часа на выбор — в днях. Произвольный срок не нужен: это решение-дисциплина, а не планировщик. */
const HOUR_BLOCK_DAYS = [1, 3, 7, 14, 30];

/** Порядок часов в селекте — как в гистограмме подсказки: торговый день 7ч…6ч. */
const DAY_START_HOUR = 7;
const HOURS_IN_DAY = 24;
const DAY_HOURS = Array.from({ length: HOURS_IN_DAY }, (_, i) => (DAY_START_HOUR + i) % HOURS_IN_DAY);

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/** «6д 03:12:45» / «3:12:45» / «12:45» — время до разблокировки. */
function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const days = Math.floor(ms / DAY_MS);
  const totalSeconds = Math.floor((ms % DAY_MS) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}д ${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${minutes}:${pad2(seconds)}`;
}

/** Дата и время ISO-момента в таймзоне риск-плана: «5.10 14:00». */
function formatLocal(iso: string, tzOffsetMinutes: number): string {
  const shifted = new Date(new Date(iso).getTime() + tzOffsetMinutes * MINUTE_MS);
  return `${shifted.getUTCDate()}.${pad2(shifted.getUTCMonth() + 1)} ${shifted.getUTCHours()}:${pad2(shifted.getUTCMinutes())}`;
}

/** Только время ISO-момента в таймзоне риск-плана: «14:00». */
function formatLocalTime(iso: string, tzOffsetMinutes: number): string {
  const shifted = new Date(new Date(iso).getTime() + tzOffsetMinutes * MINUTE_MS);
  return `${shifted.getUTCHours()}:${pad2(shifted.getUTCMinutes())}`;
}

/** Тикает раз в секунду, пока на экране есть хоть один таймер. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [enabled]);
  return now;
}

/**
 * Кнопка с подтверждением вторым нажатием: блокировку нельзя снять, поэтому между
 * «хочу» и «сделано» стоит явный шаг. Без системного confirm — он выбивается из стиля.
 */
function ConfirmButton({
  label,
  confirmLabel,
  disabled,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [arming, setArming] = useState(false);

  // Передумать можно, пока не подтвердил: сброс при любом изменении формы снаружи
  // не нужен — кнопка «Отмена» рядом.
  if (arming && !disabled) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-amber-700">{confirmLabel}</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setArming(false);
              onConfirm();
            }}
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white"
          >
            Да, закрыть
          </button>
          <button
            type="button"
            onClick={() => setArming(false)}
            className="rounded-lg border border-line px-4 py-2 text-sm text-slate-600"
          >
            Отмена
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setArming(true)}
      className="self-start rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
    >
      {label}
    </button>
  );
}

export function TradingBlocksSection() {
  const [blocks, setBlocks] = useState<TradingBlocks | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [hour, setHour] = useState(DAY_START_HOUR);
  const [days, setDays] = useState(HOUR_BLOCK_DAYS[0]!);

  const [date, setDate] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const hasTimers = (blocks?.hours.length ?? 0) > 0 || (blocks?.windows.length ?? 0) > 0;
  const now = useNow(hasTimers);

  useEffect(() => {
    getTradingBlocks()
      .then(setBlocks)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить блокировки"));
  }, []);

  async function run(action: () => Promise<TradingBlocks>) {
    setError(null);
    setIsBusy(true);
    try {
      setBlocks(await action());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось поставить блокировку");
    } finally {
      setIsBusy(false);
    }
  }

  const tz = blocks?.tzOffsetMinutes ?? 180;
  const blockedHours = new Set(blocks?.hours.map((entry) => entry.hour) ?? []);
  const windowFilled = date !== "" && from !== "" && to !== "";

  return (
    <>
      <section className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
        <div>
          <h2 className="text-sm font-medium text-ink">Закрытые часы</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Час закрывается на срок и открыть его раньше нельзя — только дождаться таймера.
            Время по МСК.
          </p>
        </div>

        {blocks && blocks.hours.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {blocks.hours.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2.5"
              >
                <span className="text-sm text-ink">{entry.hour}:00</span>
                <span className="text-xs tabular-nums text-slate-500">
                  откроется через{" "}
                  <span className="font-medium text-ink">
                    {formatCountdown(new Date(entry.endsAt).getTime() - now)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {blocks && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <select
                value={hour}
                onChange={(event) => setHour(Number(event.target.value))}
                className="rounded-md border border-line bg-transparent px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
              >
                {DAY_HOURS.map((value) => (
                  <option key={value} value={value} disabled={blockedHours.has(value)}>
                    {value}:00{blockedHours.has(value) ? " — закрыт" : ""}
                  </option>
                ))}
              </select>
              <span className="text-xs text-slate-500">на</span>
              <select
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
                className="rounded-md border border-line bg-transparent px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
              >
                {HOUR_BLOCK_DAYS.map((value) => (
                  <option key={value} value={value}>
                    {value} {value === 1 ? "день" : value < 5 ? "дня" : "дней"}
                  </option>
                ))}
              </select>
            </div>
            <ConfirmButton
              label="Закрыть час"
              confirmLabel={`Закрыть ${hour}:00 на ${days} ${days === 1 ? "день" : days < 5 ? "дня" : "дней"}? Открыть раньше срока будет нельзя.`}
              disabled={isBusy || blockedHours.has(hour)}
              onConfirm={() => run(() => blockHourRequest(hour, days))}
            />
          </div>
        )}

        {error && <p className="text-xs text-red-600">{error}</p>}
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
        <div>
          <h2 className="text-sm font-medium text-ink">Блокировка по расписанию</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            День и время «с … до» по МСК: в этом промежутке торговля будет закрыта целиком,
            отменить запланированное нельзя.
          </p>
        </div>

        {blocks && blocks.windows.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {blocks.windows.map((entry) => {
              const startsMs = new Date(entry.startsAt).getTime();
              const endsMs = new Date(entry.endsAt).getTime();
              const active = startsMs <= now;
              return (
                <li
                  key={entry.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2.5"
                >
                  <span className="text-sm text-ink">
                    {formatLocal(entry.startsAt, tz)}–{formatLocalTime(entry.endsAt, tz)}
                  </span>
                  <span className="text-xs tabular-nums text-slate-500">
                    {active ? "откроется через " : "начнётся через "}
                    <span className="font-medium text-ink">
                      {formatCountdown((active ? endsMs : startsMs) - now)}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {blocks && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className="rounded-md border border-line bg-transparent px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
              />
              <span className="text-xs text-slate-500">с</span>
              <input
                type="time"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className="rounded-md border border-line bg-transparent px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
              />
              <span className="text-xs text-slate-500">до</span>
              <input
                type="time"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                className="rounded-md border border-line bg-transparent px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
              />
            </div>
            <ConfirmButton
              label="Запланировать"
              confirmLabel={`Закрыть торговлю ${date.split("-").reverse().join(".")} с ${from} до ${to} (МСК)? Отменить будет нельзя.`}
              disabled={isBusy || !windowFilled}
              onConfirm={() => run(() => scheduleWindowRequest(date, from, to))}
            />
          </div>
        )}
      </section>
    </>
  );
}
