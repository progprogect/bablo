import { useEffect, useState } from "react";
import {
  ApiError,
  getAssets,
  getRiskSettings,
  updateAssetRequest,
  updateRiskSettingsRequest,
} from "../../api/client";
import type { Asset, RiskSettings } from "../../api/types";
import { formatPct } from "../../lib/format";

/** Синхрон с MIN_STOP_PCT/MAX_STOP_PCT в server/src/api/admin.ts — сервер проверяет те же числа. */
const MIN_PCT = 0.01;
const MAX_PCT = 100;

function displayName(symbol: string): string {
  return symbol.replace(/-USDT$/, "");
}

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

function pctLabel(value: number | null): string {
  return value !== null ? `${formatPct(value)}%` : "не задан";
}

/**
 * Расстояние между ценой входа и стопом (правило пользователя от 18.10.2026; минимумы
 * по активам — с 14.11.2026). Проверка живёт на сервере (`server/src/risk/stopDistance.ts`
 * и `trades/service.ts`): минимум берётся у открываемого актива, максимум и тумблер —
 * общие из настроек риск-плана.
 *
 * Устройство повторяет карточку «Плечо активов» (просьба пользователя от 14.11.2026):
 * строки по активам, «Редактировать» → поля → «Сохранить», до «Сохранить» на сервер не
 * уходит ничего. Строка «Максимум» одна на все активы — она сохраняется в risk-settings,
 * а не в актив. Тумблер в шапке включает и выключает проверку сразу, не трогая числа:
 * выключить правило на время — обычная операция, и вводить границы заново после этого
 * не нужно.
 */
export function StopDistanceCard() {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [settings, setSettings] = useState<RiskSettings | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [maxDraft, setMaxDraft] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getAssets(), getRiskSettings()])
      .then(([loadedAssets, loadedSettings]) => {
        setAssets(loadedAssets);
        setSettings(loadedSettings);
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Не удалось загрузить настройки"),
      );
  }, []);

  const loaded = assets !== null && settings !== null;

  async function toggleEnabled() {
    if (!settings) return;
    setJustSaved(false);
    setError(null);
    setIsSaving(true);
    try {
      setSettings(
        await updateRiskSettingsRequest({
          stopDistanceCheckEnabled: !settings.stopDistanceCheckEnabled,
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить настройки");
    } finally {
      setIsSaving(false);
    }
  }

  function startEdit() {
    if (!assets || !settings) return;
    setDrafts(
      Object.fromEntries(
        assets.map((asset) => [asset.id, asset.minStopPct === null ? "" : String(asset.minStopPct)]),
      ),
    );
    setMaxDraft(settings.maxStopDistancePct === null ? "" : String(settings.maxStopDistancePct));
    setIsEditing(true);
    setJustSaved(false);
    setError(null);
  }

  function cancelEdit() {
    setIsEditing(false);
    setDrafts({});
    setError(null);
  }

  async function handleSave() {
    if (!assets || !settings) return;

    // Сначала проверяем ВСЕ поля и только потом отправляем хоть одно: иначе при опечатке
    // в последнем активе первые уже уехали бы на сервер, а экран остался бы в правке.
    const invalid = assets.filter((asset) => !parsePctField(drafts[asset.id] ?? "").ok);
    const max = parsePctField(maxDraft);
    if (invalid.length > 0 || !max.ok) {
      const names = [
        ...invalid.map((asset) => displayName(asset.symbol)),
        ...(max.ok ? [] : ["Максимум"]),
      ];
      setError(`Процент — число от ${formatPct(MIN_PCT)} до ${MAX_PCT} (пустое поле — без ограничения). Проверьте: ${names.join(", ")}`);
      return;
    }
    const tooBigMin = assets.filter((asset) => {
      const min = parsePctField(drafts[asset.id] ?? "");
      return min.ok && min.value !== null && max.value !== null && min.value > max.value;
    });
    if (tooBigMin.length > 0) {
      setError(
        `Минимум не может быть больше максимума. Проверьте: ${tooBigMin
          .map((asset) => displayName(asset.symbol))
          .join(", ")}`,
      );
      return;
    }

    const changedAssets = assets.filter((asset) => {
      const min = parsePctField(drafts[asset.id] ?? "");
      return min.ok && min.value !== asset.minStopPct;
    });
    const maxChanged = max.value !== settings.maxStopDistancePct;
    if (changedAssets.length === 0 && !maxChanged) {
      setIsEditing(false);
      setDrafts({});
      return;
    }

    setIsSaving(true);
    setError(null);
    const failed: string[] = [];
    // Последовательно, а не Promise.all: активов единицы, зато при отказе видно, что
    // именно сохранилось, и повторная отправка не уходит пачкой.
    for (const asset of changedAssets) {
      const min = parsePctField(drafts[asset.id] ?? "");
      if (!min.ok) continue;
      try {
        const updated = await updateAssetRequest(asset.id, { minStopPct: min.value });
        setAssets((current) => current?.map((a) => (a.id === asset.id ? updated : a)) ?? null);
      } catch {
        failed.push(displayName(asset.symbol));
      }
    }
    if (maxChanged) {
      try {
        setSettings(await updateRiskSettingsRequest({ maxStopDistancePct: max.value }));
      } catch {
        failed.push("Максимум");
      }
    }
    setIsSaving(false);

    if (failed.length > 0) {
      // Остаёмся в правке: поля неудавшихся значений всё ещё содержат то, что хотели
      // сохранить, и «Сохранить» можно нажать ещё раз, не набирая заново. Сохранённые
      // к этому моменту уже не считаются изменёнными — повторно они не уйдут.
      setError(`Не удалось сохранить: ${failed.join(", ")}. Попробуйте ещё раз.`);
      return;
    }

    setIsEditing(false);
    setDrafts({});
    setJustSaved(true);
  }

  const enabled = settings?.stopDistanceCheckEnabled ?? false;

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-ink">Расстояние до стопа</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Разрыв между ценой входа и SL в процентах — как в TradingView. Вход за границами
            закрыт.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Проверка расстояния до стопа"
          disabled={!loaded || isSaving}
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

      {!loaded && !error && <p className="text-xs text-slate-500">Загрузка…</p>}

      {loaded && (
        <>
          <ul className="flex flex-col gap-1.5">
            {assets.map((asset) => (
              <li key={asset.id} className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2">
                <span className="flex-1 truncate text-sm text-ink">
                  {displayName(asset.symbol)}
                  {!asset.isActive && (
                    <span className="ml-1.5 text-[11px] text-slate-400">выключен</span>
                  )}
                </span>
                {isEditing ? (
                  <>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min={MIN_PCT}
                      max={MAX_PCT}
                      placeholder="—"
                      value={drafts[asset.id] ?? ""}
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [asset.id]: event.target.value }))
                      }
                      disabled={isSaving}
                      aria-label={`Минимум расстояния до стопа ${displayName(asset.symbol)}, %`}
                      className="w-20 rounded-lg border border-line bg-card px-2 py-1 text-center text-sm text-ink outline-none focus:border-accent disabled:opacity-50"
                    />
                    <span className="text-xs text-slate-500">%</span>
                  </>
                ) : (
                  <span
                    className={`text-sm tabular-nums ${
                      asset.minStopPct !== null ? "text-ink" : "text-slate-400"
                    }`}
                  >
                    {pctLabel(asset.minStopPct)}
                  </span>
                )}
              </li>
            ))}

            {/* Максимум один на все активы: он ловит явно ошибочный, слишком далёкий стоп,
                и по активам его различать незачем. Хранится в risk-settings. */}
            <li className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2">
              <span className="flex-1 truncate text-xs text-slate-500">Максимум — все активы</span>
              {isEditing ? (
                <>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min={MIN_PCT}
                    max={MAX_PCT}
                    placeholder="—"
                    value={maxDraft}
                    onChange={(event) => setMaxDraft(event.target.value)}
                    disabled={isSaving}
                    aria-label="Максимальное расстояние до стопа, %"
                    className="w-20 rounded-lg border border-line bg-card px-2 py-1 text-center text-sm text-ink outline-none focus:border-accent disabled:opacity-50"
                  />
                  <span className="text-xs text-slate-500">%</span>
                </>
              ) : (
                <span
                  className={`text-sm tabular-nums ${
                    settings.maxStopDistancePct !== null ? "text-ink" : "text-slate-400"
                  }`}
                >
                  {pctLabel(settings.maxStopDistancePct)}
                </span>
              )}
            </li>
          </ul>

          {isEditing ? (
            <p className="text-[11px] text-slate-400">Пустое поле — без ограничения с этой стороны.</p>
          ) : !enabled ? (
            <p className="text-[11px] text-slate-400">
              Проверка выключена — стоп можно ставить на любом расстоянии.
            </p>
          ) : (
            <p className="text-[11px] text-slate-400">
              Числа — минимум для каждого актива: стоп не ближе этого процента от входа.
              Применяется к новым сделкам, открытую позицию не трогает.
            </p>
          )}

          <div className="flex items-center gap-2">
            {isEditing ? (
              <>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={isSaving}
                  className="flex-1 rounded-xl bg-accent py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {isSaving ? "Сохраняю…" : "Сохранить"}
                </button>
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={isSaving}
                  className="rounded-xl border border-line px-4 py-2 text-sm text-slate-600 disabled:opacity-50"
                >
                  Отмена
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={startEdit}
                  disabled={isSaving}
                  className="flex-1 rounded-xl border border-line py-2 text-sm font-medium text-accent disabled:opacity-50"
                >
                  Редактировать
                </button>
                {justSaved && <span className="text-[11px] text-emerald-600">сохранено</span>}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
