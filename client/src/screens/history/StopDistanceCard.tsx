import { useEffect, useState } from "react";
import { ApiError, getRiskSettings, updateRiskSettingsRequest } from "../../api/client";
import type { RiskSettings } from "../../api/types";
import { formatPct } from "../../lib/format";

/** Границы процента: те же числа проверяет сервер (api/admin.ts). */
const MIN_PCT = 0.01;
const MAX_PCT = 100;

/**
 * Поле процента → число, null или ошибка. Пустое поле — осознанное «без ограничения»,
 * поэтому это валидное значение, а не промах ввода. Запятую принимаем: на телефоне
 * цифровая клавиатура даёт именно её.
 */
function parsePctField(draft: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = draft.trim().replace(",", ".");
  if (trimmed === "") return { ok: true, value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < MIN_PCT || value > MAX_PCT) return { ok: false };
  // До сотых — дальше знаков правило всё равно не различает (сравнение округлённое).
  return { ok: true, value: Math.round(value * 100) / 100 };
}

type Phase = "read" | "edit" | "confirm";

/**
 * Расстояние между ценой входа и стопом (правило пользователя от 18.10.2026).
 *
 * Процент считается от цены входа — та же база, что у инструмента «длинная позиция» в
 * TradingView. Логика проверки живёт на сервере (`server/src/risk/stopDistance.ts`),
 * здесь только чтение и правка границ.
 *
 * Тумблер в шапке включает и выключает проверку, не трогая сами числа: выключить правило
 * на время — обычная операция, и вводить границы заново после этого не нужно. Он работает
 * сразу, без «Сохранить», — так это и ведёт себя как тумблер. Сами границы правятся
 * иначе: «Редактировать» → поля → «Сохранить» → подтверждение. На сервер до подтверждения
 * не уходит ничего.
 */
export function StopDistanceCard() {
  const [settings, setSettings] = useState<RiskSettings | null>(null);
  const [phase, setPhase] = useState<Phase>("read");
  const [minDraft, setMinDraft] = useState("");
  const [maxDraft, setMaxDraft] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getRiskSettings()
      .then(setSettings)
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Не удалось загрузить настройки"),
      );
  }, []);

  async function patch(update: Partial<RiskSettings>): Promise<boolean> {
    setIsSaving(true);
    setError(null);
    try {
      setSettings(await updateRiskSettingsRequest(update));
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить настройки");
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function toggleEnabled() {
    if (!settings) return;
    setJustSaved(false);
    await patch({ stopDistanceCheckEnabled: !settings.stopDistanceCheckEnabled });
  }

  function startEdit() {
    if (!settings) return;
    setMinDraft(settings.minStopDistancePct === null ? "" : String(settings.minStopDistancePct));
    setMaxDraft(settings.maxStopDistancePct === null ? "" : String(settings.maxStopDistancePct));
    setPhase("edit");
    setJustSaved(false);
    setError(null);
  }

  function cancelEdit() {
    setPhase("read");
    setError(null);
  }

  /** Проверяем оба поля разом и только потом показываем подтверждение. */
  function reviewEdit() {
    const min = parsePctField(minDraft);
    const max = parsePctField(maxDraft);
    if (!min.ok || !max.ok) {
      setError(`Процент — число от ${formatPct(MIN_PCT)} до ${MAX_PCT}`);
      return;
    }
    if (min.value !== null && max.value !== null && min.value > max.value) {
      setError("Минимум не может быть больше максимума");
      return;
    }
    setError(null);
    setPhase("confirm");
  }

  async function confirmEdit() {
    const min = parsePctField(minDraft);
    const max = parsePctField(maxDraft);
    if (!min.ok || !max.ok) return;
    const saved = await patch({
      minStopDistancePct: min.value,
      maxStopDistancePct: max.value,
    });
    if (saved) {
      setPhase("read");
      setJustSaved(true);
    }
  }

  const enabled = settings?.stopDistanceCheckEnabled ?? false;
  const minLabel =
    settings?.minStopDistancePct != null ? `${formatPct(settings.minStopDistancePct)}%` : "не задан";
  const maxLabel =
    settings?.maxStopDistancePct != null ? `${formatPct(settings.maxStopDistancePct)}%` : "не задан";
  const noLimits =
    settings !== null && settings.minStopDistancePct === null && settings.maxStopDistancePct === null;

  // Текст подтверждения строим из черновиков — показываем ровно то, что сохранится.
  const pendingMin = parsePctField(minDraft);
  const pendingMax = parsePctField(maxDraft);
  const pendingLabel = (() => {
    const min = pendingMin.ok && pendingMin.value !== null ? `${formatPct(pendingMin.value)}%` : null;
    const max = pendingMax.ok && pendingMax.value !== null ? `${formatPct(pendingMax.value)}%` : null;
    if (min && max) return `Новые границы: ${min} — ${max}.`;
    if (min) return `Новая граница: не ближе ${min}, сверху без ограничения.`;
    if (max) return `Новая граница: не дальше ${max}, снизу без ограничения.`;
    return "Обе границы будут сняты — проверка перестанет что-либо блокировать.";
  })();

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-ink">Расстояние до стопа</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Разрыв между ценой входа и SL, в процентах от цены входа — как в TradingView.
            Вход за границами закрыт.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Проверка расстояния до стопа"
          disabled={settings === null || isSaving}
          onClick={toggleEnabled}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            enabled ? "bg-accent" : "bg-slate-300"
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
              enabled ? "left-[22px]" : "left-0.5"
            }`}
          />
        </button>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {settings === null && !error && <p className="text-xs text-slate-500">Загрузка…</p>}

      {settings !== null && phase === "read" && (
        <>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between rounded-xl bg-surface px-3 py-2">
              <span className="text-xs text-slate-500">Минимум</span>
              <span
                className={`text-sm tabular-nums ${
                  settings.minStopDistancePct != null ? "text-ink" : "text-slate-400"
                }`}
              >
                {minLabel}
              </span>
            </div>
            <div className="flex items-center justify-between rounded-xl bg-surface px-3 py-2">
              <span className="text-xs text-slate-500">Максимум</span>
              <span
                className={`text-sm tabular-nums ${
                  settings.maxStopDistancePct != null ? "text-ink" : "text-slate-400"
                }`}
              >
                {maxLabel}
              </span>
            </div>
          </div>

          {/* Две разные причины, по которым правило ничего не делает, и их нельзя путать:
              выключено тумблером — или включено, но границ нет. */}
          {!enabled ? (
            <p className="text-[11px] text-slate-400">
              Проверка выключена — стоп можно ставить на любом расстоянии.
            </p>
          ) : noLimits ? (
            <p className="text-[11px] text-slate-400">
              Границы не заданы — проверять нечего. Укажите хотя бы одну.
            </p>
          ) : (
            <p className="text-[11px] text-slate-400">
              Применяется к новым сделкам, открытую позицию не трогает.
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={startEdit}
              disabled={isSaving}
              className="flex-1 rounded-xl border border-line py-2 text-sm font-medium text-accent disabled:opacity-50"
            >
              Редактировать
            </button>
            {justSaved && <span className="text-[11px] text-emerald-600">сохранено</span>}
          </div>
        </>
      )}

      {settings !== null && phase === "edit" && (
        <>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2 rounded-xl bg-surface px-3 py-2">
              <span className="text-xs text-slate-500">Минимум</span>
              <span className="flex items-center gap-1.5">
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={MIN_PCT}
                  max={MAX_PCT}
                  placeholder="—"
                  value={minDraft}
                  onChange={(event) => setMinDraft(event.target.value)}
                  aria-label="Минимальное расстояние до стопа, %"
                  className="w-20 rounded-lg border border-line bg-card px-2 py-1 text-center text-sm text-ink outline-none focus:border-accent"
                />
                <span className="text-xs text-slate-500">%</span>
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 rounded-xl bg-surface px-3 py-2">
              <span className="text-xs text-slate-500">Максимум</span>
              <span className="flex items-center gap-1.5">
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={MIN_PCT}
                  max={MAX_PCT}
                  placeholder="—"
                  value={maxDraft}
                  onChange={(event) => setMaxDraft(event.target.value)}
                  aria-label="Максимальное расстояние до стопа, %"
                  className="w-20 rounded-lg border border-line bg-card px-2 py-1 text-center text-sm text-ink outline-none focus:border-accent"
                />
                <span className="text-xs text-slate-500">%</span>
              </span>
            </div>
          </div>

          <p className="text-[11px] text-slate-400">Пустое поле — без ограничения с этой стороны.</p>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={reviewEdit}
              className="flex-1 rounded-xl bg-accent py-2 text-sm font-medium text-white"
            >
              Сохранить
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              className="rounded-xl border border-line px-4 py-2 text-sm text-slate-600"
            >
              Отмена
            </button>
          </div>
        </>
      )}

      {settings !== null && phase === "confirm" && (
        <>
          <div className="rounded-xl bg-amber-50 px-3 py-2.5">
            <p className="text-xs leading-snug text-amber-700">
              {pendingLabel} Применится со следующей сделки, открытую позицию не тронет.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={isSaving}
              onClick={confirmEdit}
              className="flex-1 rounded-xl bg-amber-600 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {isSaving ? "Сохраняю…" : "Да, сохранить"}
            </button>
            <button
              type="button"
              disabled={isSaving}
              onClick={() => setPhase("edit")}
              className="rounded-xl border border-line px-4 py-2 text-sm text-slate-600 disabled:opacity-50"
            >
              Отмена
            </button>
          </div>
        </>
      )}
    </section>
  );
}
