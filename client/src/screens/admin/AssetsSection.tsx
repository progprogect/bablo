import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  createAssetRequest,
  deleteAssetRequest,
  getAssets,
  updateAssetRequest,
} from "../../api/client";
import type { Asset } from "../../api/types";

export function AssetsSection() {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newSymbol, setNewSymbol] = useState("");
  const [newLeverage, setNewLeverage] = useState("20");

  useEffect(() => {
    getAssets()
      .then(setAssets)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить активы"));
  }, []);

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const leverage = Number(newLeverage);
    if (!newSymbol.trim() || !Number.isInteger(leverage) || leverage < 1) {
      setError("Укажите символ и корректное плечо");
      return;
    }
    try {
      const symbol = newSymbol.trim().toUpperCase();
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

  async function handleLeverageChange(asset: Asset, value: string) {
    const leverage = Number(value);
    if (!Number.isInteger(leverage) || leverage < 1) return;
    try {
      const updated = await updateAssetRequest(asset.id, { leverage });
      setAssets((current) => current?.map((a) => (a.id === asset.id ? updated : a)) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось обновить плечо");
    }
  }

  async function handleToggleActive(asset: Asset) {
    try {
      const updated = await updateAssetRequest(asset.id, { isActive: !asset.isActive });
      setAssets((current) => current?.map((a) => (a.id === asset.id ? updated : a)) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось изменить актив");
    }
  }

  async function handleDelete(asset: Asset) {
    try {
      await deleteAssetRequest(asset.id);
      setAssets((current) => current?.filter((a) => a.id !== asset.id) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось удалить актив");
    }
  }

  return (
    <section className="flex flex-col gap-3 pt-6">
      <h2 className="text-sm font-medium text-slate-100">Активы</h2>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <ul className="flex flex-col gap-2">
        {assets?.map((asset) => (
          <li
            key={asset.id}
            className="flex items-center gap-2 rounded-lg border border-slate-800 px-3 py-2"
          >
            <span className="flex-1 text-sm text-slate-100">{asset.symbol}</span>
            <input
              type="number"
              min={1}
              max={125}
              value={asset.leverage}
              onChange={(event) => handleLeverageChange(asset, event.target.value)}
              className="w-16 rounded-md border border-slate-800 bg-transparent px-2 py-1 text-center text-sm text-slate-100 outline-none focus:border-accent"
            />
            <span className="text-xs text-slate-500">x</span>
            <button
              type="button"
              onClick={() => handleToggleActive(asset)}
              className={
                asset.isActive
                  ? "rounded-md bg-accent/20 px-2 py-1 text-xs text-accent"
                  : "rounded-md bg-slate-800 px-2 py-1 text-xs text-slate-500"
              }
            >
              {asset.isActive ? "включён" : "выключен"}
            </button>
            <button
              type="button"
              onClick={() => handleDelete(asset)}
              className="rounded-md px-2 py-1 text-xs text-red-400"
            >
              удалить
            </button>
          </li>
        ))}
      </ul>

      <form onSubmit={handleAdd} className="flex items-center gap-2 pt-1">
        <input
          type="text"
          placeholder="Символ (напр. TIA)"
          value={newSymbol}
          onChange={(event) => setNewSymbol(event.target.value)}
          className="flex-1 rounded-lg border border-slate-800 bg-transparent px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent"
        />
        <input
          type="number"
          min={1}
          max={125}
          value={newLeverage}
          onChange={(event) => setNewLeverage(event.target.value)}
          className="w-16 rounded-lg border border-slate-800 bg-transparent px-2 py-2 text-center text-sm text-slate-100 outline-none focus:border-accent"
        />
        <button
          type="submit"
          className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-surface"
        >
          Добавить
        </button>
      </form>
    </section>
  );
}
