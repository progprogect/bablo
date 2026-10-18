import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  createAssetRequest,
  deleteAssetRequest,
  getAssets,
  updateAssetRequest,
} from "../api/client";
import type { Asset } from "../api/types";

/** Синхрон с MAX_LEVERAGE в server/src/api/admin.ts — там тот же порог проверяется повторно. */
const MAX_LEVERAGE = 125;

function displayName(symbol: string): string {
  return symbol.replace(/-USDT$/, "");
}

/**
 * Плечо из поля ввода: целое от 1 до MAX_LEVERAGE, иначе null. Пустая строка тоже null —
 * `Number("")` даёт 0, и без явной проверки диапазона ноль уехал бы на сервер.
 */
function parseLeverage(draft: string): number | null {
  const value = Number(draft.trim());
  if (!Number.isInteger(value) || value < 1 || value > MAX_LEVERAGE) return null;
  return value;
}

/**
 * Активы и их плечо. Один компонент на два экрана (просьба пользователя от 18.10.2026 —
 * «не перенести, а продублировать»): в «Настройках» — только плечо, в админке — ещё и
 * состав набора (`manage`). Логика правки плеча при этом ОДНА: раньше она жила в двух
 * местах и успела разойтись поведением.
 *
 * Правка — через явный режим: «Редактировать» → поля → «Сохранить». Так было не всегда.
 * Первый заход (16.10.2026) сохранял по уходу с поля и был откачен из-за багов: на
 * мобильном `blur` случается и при скролле, то есть правка уходила на сервер в момент,
 * когда её не просили, а до того админка слала PATCH вообще на каждое нажатие — и
 * промежуточное «2» на пути к «20» успевало стать настоящим плечом. Явная кнопка
 * убирает оба случая: до «Сохранить» на сервер не уходит ничего.
 *
 * Плечо применяется на бирже в момент входа (`trades/service.ts`), поэтому новая цифра
 * действует со следующей сделки, а открытую позицию не меняет — об этом говорит подпись.
 */
export function AssetsCard({ manage = false }: { manage?: boolean }) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newSymbol, setNewSymbol] = useState("");
  const [newLeverage, setNewLeverage] = useState("20");

  useEffect(() => {
    getAssets()
      .then(setAssets)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить активы"));
  }, []);

  function startEdit() {
    if (!assets) return;
    setDrafts(Object.fromEntries(assets.map((asset) => [asset.id, String(asset.leverage)])));
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
    if (!assets) return;

    // Сначала проверяем ВСЕ поля и только потом отправляем хоть одно: иначе при опечатке
    // в последнем активе первые уже уехали бы на сервер, а экран остался бы в правке.
    const invalid = assets.filter((asset) => parseLeverage(drafts[asset.id] ?? "") === null);
    if (invalid.length > 0) {
      setError(
        `Плечо — целое от 1 до ${MAX_LEVERAGE}. Проверьте: ${invalid
          .map((asset) => displayName(asset.symbol))
          .join(", ")}`,
      );
      return;
    }

    const changed = assets.filter((asset) => parseLeverage(drafts[asset.id]!) !== asset.leverage);
    if (changed.length === 0) {
      setIsEditing(false);
      setDrafts({});
      return;
    }

    setIsSaving(true);
    setError(null);
    const failed: string[] = [];
    // Последовательно, а не Promise.all: активов единицы, зато при отказе видно, что
    // именно сохранилось, и повторная отправка не уходит пачкой.
    for (const asset of changed) {
      const leverage = parseLeverage(drafts[asset.id]!)!;
      try {
        const updated = await updateAssetRequest(asset.id, { leverage });
        setAssets((current) => current?.map((a) => (a.id === asset.id ? updated : a)) ?? null);
      } catch {
        failed.push(displayName(asset.symbol));
      }
    }
    setIsSaving(false);

    if (failed.length > 0) {
      // Остаёмся в правке: поля неудавшихся активов всё ещё содержат то, что хотели
      // сохранить, и «Сохранить» можно нажать ещё раз, не набирая заново. Сохранённые
      // к этому моменту уже не считаются изменёнными — повторно они не уйдут.
      setError(`Не удалось сохранить: ${failed.join(", ")}. Попробуйте ещё раз.`);
      return;
    }

    setIsEditing(false);
    setDrafts({});
    setJustSaved(true);
  }

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const leverage = parseLeverage(newLeverage);
    const symbol = newSymbol.trim().toUpperCase();
    if (!symbol || leverage === null) {
      setError(`Укажите символ и плечо — целое от 1 до ${MAX_LEVERAGE}`);
      return;
    }
    try {
      const created = await createAssetRequest({
        symbol: symbol.includes("-") ? symbol : `${symbol}-USDT`,
        leverage,
      });
      setAssets((current) => [...(current ?? []), created]);
      setNewSymbol("");
      setNewLeverage("20");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось добавить актив");
    }
  }

  async function handleToggleActive(asset: Asset) {
    setError(null);
    try {
      const updated = await updateAssetRequest(asset.id, { isActive: !asset.isActive });
      setAssets((current) => current?.map((a) => (a.id === asset.id ? updated : a)) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось изменить актив");
    }
  }

  async function handleDelete(asset: Asset) {
    setError(null);
    try {
      await deleteAssetRequest(asset.id);
      setAssets((current) => current?.filter((a) => a.id !== asset.id) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось удалить актив");
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-ink">{manage ? "Активы" : "Плечо активов"}</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Применится со следующей сделки — плечо выставляется на бирже в момент входа.
            Уже открытую позицию не меняет.
          </p>
        </div>
        {justSaved && !isEditing && (
          <span className="shrink-0 text-[11px] text-emerald-600">сохранено</span>
        )}
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {assets === null && !error && <p className="text-xs text-slate-500">Загрузка…</p>}

      {assets !== null && assets.length === 0 && (
        <p className="text-xs text-slate-500">
          {manage ? "Активы не настроены — добавьте ниже." : "Активы не настроены — добавьте их в админке."}
        </p>
      )}

      {assets !== null && assets.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {assets.map((asset) => (
            <li
              key={asset.id}
              className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2"
            >
              <span className="flex-1 truncate text-sm text-ink">
                {displayName(asset.symbol)}
                {/* В админке состояние и так написано на кнопке-переключателе — там эта
                    приписка дала бы «WLD выключен … выключен». В «Настройках»
                    переключателя нет, и без неё непонятно, почему актива нет в табах. */}
                {!asset.isActive && !manage && (
                  <span className="ml-1.5 text-[11px] text-slate-400">выключен</span>
                )}
              </span>

              {isEditing ? (
                <>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={MAX_LEVERAGE}
                    value={drafts[asset.id] ?? String(asset.leverage)}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [asset.id]: event.target.value }))
                    }
                    disabled={isSaving}
                    aria-label={`Плечо ${displayName(asset.symbol)}`}
                    className="w-16 rounded-lg border border-line bg-card px-2 py-1 text-center text-sm text-ink outline-none focus:border-accent disabled:opacity-50"
                  />
                  <span className="text-xs text-slate-500">x</span>
                </>
              ) : (
                <>
                  <span className="text-sm tabular-nums text-ink">{asset.leverage}x</span>
                  {/* Состав набора меняем только вне режима правки: иначе рядом живут
                      несохранённый черновик плеча и структурные изменения списка, и по
                      экрану уже не понять, что из этого на сервере, а что нет. */}
                  {manage && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleToggleActive(asset)}
                        className={
                          asset.isActive
                            ? "rounded-md bg-accent/15 px-2 py-1 text-xs text-accent"
                            : "rounded-md bg-slate-200 px-2 py-1 text-xs text-slate-500"
                        }
                      >
                        {asset.isActive ? "включён" : "выключен"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(asset)}
                        className="rounded-md px-2 py-1 text-xs text-red-600"
                      >
                        удалить
                      </button>
                    </>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {assets !== null && assets.length > 0 && (
        <div className="flex gap-2">
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
            <button
              type="button"
              onClick={startEdit}
              className="flex-1 rounded-xl border border-line py-2 text-sm font-medium text-accent"
            >
              Редактировать
            </button>
          )}
        </div>
      )}

      {manage && !isEditing && (
        <form onSubmit={handleAdd} className="flex items-center gap-2 border-t border-line pt-3">
          <input
            type="text"
            placeholder="Символ (напр. TIA)"
            value={newSymbol}
            onChange={(event) => setNewSymbol(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
          />
          <input
            type="number"
            min={1}
            max={MAX_LEVERAGE}
            value={newLeverage}
            onChange={(event) => setNewLeverage(event.target.value)}
            aria-label="Плечо нового актива"
            className="w-16 rounded-lg border border-line bg-card px-2 py-2 text-center text-sm text-ink outline-none focus:border-accent"
          />
          <button
            type="submit"
            className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white"
          >
            Добавить
          </button>
        </form>
      )}
    </section>
  );
}
