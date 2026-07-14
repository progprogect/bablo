import { useEffect, useRef, useState } from "react";
import { ApiError, getDashboard } from "../api/client";
import { subscribeToEvents } from "../api/sse";
import type { ActiveTradeView, DashboardResponse } from "../api/types";
import { AssetTabs } from "../components/AssetTabs";
import { TradeForm } from "./dashboard/TradeForm";
import { ActiveTradeCard } from "./dashboard/ActiveTradeCard";
import { ExternalPositionsPanel } from "./dashboard/ExternalPositionsPanel";
import { BlockedPanel } from "./dashboard/BlockedPanel";
import { LevelIndicator } from "./dashboard/LevelIndicator";
import { RiskTreeSheet } from "./dashboard/RiskTreeSheet";

const LEVEL_UP_GLOW_MS = 2500;

/** Показываем equity как на BingX — без лишнего округления до 2 знаков. */
function formatFuturesEquity(value: string | null | undefined): string {
  if (!value) return "0.00";
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function Dashboard() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [treeOpen, setTreeOpen] = useState(false);
  const [justLeveledUp, setJustLeveledUp] = useState(false);
  const previousLevelRef = useRef<number | null>(null);

  useEffect(() => {
    loadDashboard();
  }, []);

  // Живая цена и сигнал на перезагрузку дашборда — без REST-поллинга (Этап 4).
  useEffect(() => {
    const unsubscribe = subscribeToEvents({
      onPrice: ({ symbol, price }) => {
        setLivePrices((current) => ({ ...current, [symbol]: price }));
      },
      onRefresh: () => loadDashboard(),
    });
    return unsubscribe;
  }, []);

  function loadDashboard() {
    getDashboard()
      .then((response) => {
        setData(response);
        setSelectedSymbol((current) => current ?? response.assets[0]?.symbol ?? null);

        const previousLevel = previousLevelRef.current;
        if (previousLevel !== null && response.risk.currentLevel > previousLevel) {
          setJustLeveledUp(true);
          setTimeout(() => setJustLeveledUp(false), LEVEL_UP_GLOW_MS);
        }
        previousLevelRef.current = response.risk.currentLevel;
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить дашборд"));
  }

  function handleTradeUpdated(activeTrade: ActiveTradeView) {
    setData((current) => (current ? { ...current, activeTrade } : current));
  }

  if (error) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm text-red-600">{error}</p>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="flex flex-1 items-center justify-center px-6 text-sm text-slate-500">
        Загрузка…
      </section>
    );
  }

  const hasExternalPositions = data.externalPositions.length > 0;
  const isBlocked = !data.activeTrade && !hasExternalPositions && data.risk.activeLocks.length > 0;

  return (
    <section className="flex flex-1 flex-col gap-6 pt-10">
      <BalanceCard balance={data.balance} balanceError={data.balanceError} />

      <LevelIndicator
        currentLevel={data.risk.currentLevel}
        accumulatedR={data.risk.accumulatedR}
        requiredR={data.risk.requiredR}
        justLeveledUp={justLeveledUp}
        onOpen={() => setTreeOpen(true)}
      />

      {treeOpen && (
        <RiskTreeSheet
          currentLevel={data.risk.currentLevel}
          accumulatedR={data.risk.accumulatedR}
          onClose={() => setTreeOpen(false)}
        />
      )}

      {notice && <p className="px-6 text-center text-sm text-amber-700">{notice}</p>}

      {data.activeTrade && (
        <ActiveTradeCard
          trade={data.activeTrade}
          livePrice={livePrices[data.activeTrade.symbol]}
          onUpdated={handleTradeUpdated}
          onClosed={loadDashboard}
        />
      )}

      {hasExternalPositions && <ExternalPositionsPanel positions={data.externalPositions} />}

      {!data.activeTrade &&
        !hasExternalPositions &&
        (isBlocked ? (
          <BlockedPanel locks={data.risk.activeLocks} onExpired={loadDashboard} />
        ) : (
          <>
            <AssetTabs assets={data.assets} selected={selectedSymbol} onSelect={setSelectedSymbol} />
            {selectedSymbol && (
              <TradeForm
                symbol={selectedSymbol}
                leverage={data.assets.find((a) => a.symbol === selectedSymbol)?.leverage ?? 1}
                levelRiskUsd={data.risk.levelRiskUsd}
                livePrice={livePrices[selectedSymbol]}
                onOpened={(result) => {
                  setNotice(result.slWarning);
                  handleTradeUpdated({
                    ...result.trade,
                    liquidationPrice: null,
                    unrealizedProfit: null,
                    positionFlat: false,
                  });
                }}
              />
            )}
          </>
        ))}
    </section>
  );
}

function BalanceCard({
  balance,
  balanceError,
}: {
  balance: DashboardResponse["balance"];
  balanceError: string | null;
}) {
  if (balanceError) {
    return (
      <div className="mx-auto text-center">
        <p className="text-xs uppercase tracking-wide text-slate-500">Депозит</p>
        <p className="mt-1 text-sm text-slate-500">{balanceError}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto text-center">
      <p className="text-xs uppercase tracking-wide text-slate-500">Депозит</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums text-ink">
        {formatFuturesEquity(balance?.equity)}{" "}
        <span className="text-base text-slate-500">USDT</span>
      </p>
      <p className="mt-0.5 text-xs text-slate-400">Фьючерсный счёт · эквити BingX</p>
    </div>
  );
}
