import { useEffect, useState } from "react";
import type { RiskLock } from "../../api/types";

function pickEffectiveLock(locks: RiskLock[]): RiskLock | null {
  if (locks.length === 0) return null;
  return locks.reduce((longest, current) =>
    new Date(current.until) > new Date(longest.until) ? current : longest,
  );
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function BlockedPanel({ locks, onExpired }: { locks: RiskLock[]; onExpired: () => void }) {
  const effective = pickEffectiveLock(locks);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!effective) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [effective]);

  useEffect(() => {
    if (effective && new Date(effective.until).getTime() <= now) {
      onExpired();
    }
  }, [effective, now, onExpired]);

  if (!effective) return null;

  const remainingMs = new Date(effective.until).getTime() - now;

  return (
    <div className="mx-4 flex flex-col items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-center">
      <p className="text-sm text-amber-700">{effective.reason}</p>
      <p className="text-2xl font-semibold tabular-nums text-amber-700">{formatRemaining(remainingMs)}</p>
    </div>
  );
}
