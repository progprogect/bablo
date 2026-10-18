import { BingxKeysSection } from "./admin/BingxKeysSection";
import { AssetsCard } from "../components/AssetsCard";
import { RiskPlanSection } from "./admin/RiskPlanSection";
import { EquityAdjustmentsSection } from "./admin/EquityAdjustmentsSection";
import { TradeCloseReasonSection } from "./admin/TradeCloseReasonSection";
import { TradeStatsRrSection } from "./admin/TradeStatsRrSection";

export function Admin() {
  return (
    <section className="flex flex-1 flex-col gap-2 px-4 pt-8">
      <h1 className="mb-2 text-lg font-medium text-ink">Админка</h1>
      <BingxKeysSection />
      <TradeCloseReasonSection />
      <TradeStatsRrSection />
      {/* Тот же компонент, что в «Настройках» (просьба от 18.10.2026: плечо правится
          в обоих местах). `manage` добавляет состав набора — добавление, включение,
          удаление; правка плеча одинаковая здесь и там. */}
      <AssetsCard manage />
      <RiskPlanSection />
      <EquityAdjustmentsSection />
    </section>
  );
}
