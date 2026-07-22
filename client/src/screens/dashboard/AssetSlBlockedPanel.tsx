import { useEffect, useState } from "react";
import type { RiskLock } from "../../api/types";

function formatRemaining(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function displaySymbol(symbol: string): string {
  return symbol.replace(/-USDT$/, "");
}

/**
 * Плашка варианта B: список активов, по которым сегодня уже был стоп.
 * Не скрывает форму — другие активы остаются доступны.
 */
export function AssetSlBlockedPanel({
  locks,
  onExpired,
}: {
  locks: RiskLock[];
  onExpired: () => void;
}) {
  const untilMs = locks.reduce((latest, lock) => {
    const ms = new Date(lock.until).getTime();
    return ms > latest ? ms : latest;
  }, 0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (locks.length === 0) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [locks.length]);

  useEffect(() => {
    if (locks.length > 0 && untilMs <= now) {
      onExpired();
    }
  }, [locks.length, untilMs, now, onExpired]);

  if (locks.length === 0) return null;

  const labels = locks
    .map((lock) => (lock.symbol ? displaySymbol(lock.symbol) : null))
    .filter((label): label is string => Boolean(label));
  const remainingMs = untilMs - now;

  return (
    <div className="mx-4 flex flex-col items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-center">
      <p className="text-sm text-amber-700">
        После стопа сегодня закрыты:{" "}
        <span className="font-medium">{labels.length > 0 ? labels.join(", ") : "—"}</span>
      </p>
      <p className="text-xs text-amber-600">Повторный вход в эти активы — после сброса дня</p>
      <p className="text-2xl font-semibold tabular-nums text-amber-700">{formatRemaining(remainingMs)}</p>
    </div>
  );
}
