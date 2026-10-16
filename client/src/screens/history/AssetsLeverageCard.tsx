import { useEffect, useState } from "react";
import { ApiError, getAssets, updateAssetRequest } from "../../api/client";
import type { Asset } from "../../api/types";

/** Синхрон с MAX_LEVERAGE в server/src/api/admin.ts — там тот же порог проверяется повторно. */
const MAX_LEVERAGE = 125;

type RowState = { draft: string; status: "idle" | "saving" | "saved"; error: string | null };

function initialRows(assets: Asset[]): Record<number, RowState> {
  return Object.fromEntries(
    assets.map((asset) => [asset.id, { draft: String(asset.leverage), status: "idle", error: null }]),
  );
}

/**
 * Плечо активов в «Настройках» (просьба пользователя от 16.10.2026). Раньше плечо жило
 * только в админке (`/admin`, пункта меню у неё нет) — чтобы поменять цифру, приходилось
 * помнить адрес и заходить туда руками.
 *
 * Здесь намеренно ТОЛЬКО плечо: добавление, выключение и удаление активов остаются в
 * админке. Это разовые операции по настройке набора, а плечо меняют по ходу торговли —
 * ему место рядом с остальными рабочими переключателями.
 *
 * Сохранение по уходу с поля, а не на каждое нажатие: в админке PATCH уходит на каждый
 * ввод, и промежуточные значения («2» на пути к «20») успевают улететь на сервер.
 */
export function AssetsLeverageCard() {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [rows, setRows] = useState<Record<number, RowState>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    getAssets()
      .then((loaded) => {
        setAssets(loaded);
        setRows(initialRows(loaded));
      })
      .catch((err) =>
        setLoadError(err instanceof ApiError ? err.message : "Не удалось загрузить активы"),
      );
  }, []);

  function patchRow(id: number, patch: Partial<RowState>) {
    setRows((current) => ({ ...current, [id]: { ...current[id]!, ...patch } }));
  }

  function editDraft(id: number, value: string) {
    patchRow(id, { draft: value, status: "idle", error: null });
  }

  async function commit(asset: Asset) {
    const row = rows[asset.id];
    if (!row) return;
    const leverage = Number(row.draft);

    if (!Number.isInteger(leverage) || leverage < 1 || leverage > MAX_LEVERAGE) {
      patchRow(asset.id, { error: `Плечо — целое от 1 до ${MAX_LEVERAGE}` });
      return;
    }
    if (leverage === asset.leverage) {
      patchRow(asset.id, { error: null, status: "idle" });
      return;
    }

    patchRow(asset.id, { status: "saving", error: null });
    try {
      const updated = await updateAssetRequest(asset.id, { leverage });
      setAssets((current) => current?.map((a) => (a.id === asset.id ? updated : a)) ?? null);
      patchRow(asset.id, { draft: String(updated.leverage), status: "saved", error: null });
    } catch (err) {
      // Возвращаем поле к сохранённому значению: иначе на экране остаётся цифра, которой
      // на сервере нет, и следующая сделка уйдёт с другим плечом, чем показано.
      patchRow(asset.id, {
        draft: String(asset.leverage),
        status: "idle",
        error: err instanceof ApiError ? err.message : "Не удалось сохранить плечо",
      });
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div>
        <h2 className="text-sm font-medium text-ink">Плечо активов</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Применится со следующей сделки — плечо выставляется на бирже в момент входа.
          Уже открытую позицию не меняет.
        </p>
      </div>

      {loadError && <p className="text-xs text-red-600">{loadError}</p>}

      {assets === null && !loadError && <p className="text-xs text-slate-500">Загрузка…</p>}

      {assets !== null && assets.length === 0 && (
        <p className="text-xs text-slate-500">Активы не настроены — добавьте их в админке.</p>
      )}

      <ul className="flex flex-col gap-1.5">
        {assets?.map((asset) => {
          const row = rows[asset.id];
          const displayName = asset.symbol.replace(/-USDT$/, "");
          return (
            <li key={asset.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2">
                <span className="flex-1 text-sm text-ink">
                  {displayName}
                  {!asset.isActive && (
                    <span className="ml-1.5 text-[11px] text-slate-400">выключен</span>
                  )}
                </span>
                {row?.status === "saved" && (
                  <span className="text-[11px] text-emerald-600">сохранено</span>
                )}
                {row?.status === "saving" && (
                  <span className="text-[11px] text-slate-400">сохраняю…</span>
                )}
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_LEVERAGE}
                  value={row?.draft ?? String(asset.leverage)}
                  onChange={(event) => editDraft(asset.id, event.target.value)}
                  onBlur={() => commit(asset)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                  disabled={row?.status === "saving"}
                  aria-label={`Плечо ${displayName}`}
                  className={`w-16 rounded-lg border bg-card px-2 py-1 text-center text-sm text-ink outline-none focus:border-accent disabled:opacity-50 ${
                    row?.error ? "border-red-400" : "border-line"
                  }`}
                />
                <span className="text-xs text-slate-500">x</span>
              </div>
              {row?.error && <p className="px-1 text-[11px] text-red-600">{row.error}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
