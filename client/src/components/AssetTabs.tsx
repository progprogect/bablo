import type { Asset } from "../api/types";

type AssetTabsProps = {
  assets: Asset[];
  selected: string | null;
  onSelect: (symbol: string) => void;
};

/** Отображаемое имя без -USDT — на бирже TIA-USDT, пользователю достаточно TIA. */
function displayName(symbol: string): string {
  return symbol.replace(/-USDT$/, "");
}

export function AssetTabs({ assets, selected, onSelect }: AssetTabsProps) {
  if (assets.length === 0) {
    return (
      <p className="px-6 text-center text-sm text-slate-500">
        Активы не настроены — добавьте их в админке.
      </p>
    );
  }

  return (
    <div className="flex justify-center gap-2 px-4">
      {assets.map((asset) => {
        const isActive = asset.symbol === selected;
        return (
          <button
            key={asset.id}
            type="button"
            onClick={() => onSelect(asset.symbol)}
            className={
              isActive
                ? "rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-surface"
                : "rounded-full border border-slate-800 px-4 py-1.5 text-sm text-slate-400"
            }
          >
            {displayName(asset.symbol)}
          </button>
        );
      })}
    </div>
  );
}
