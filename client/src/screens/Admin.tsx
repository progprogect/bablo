import { BingxKeysSection } from "./admin/BingxKeysSection";
import { AssetsSection } from "./admin/AssetsSection";
import { RiskPlanSection } from "./admin/RiskPlanSection";
import { EquityAdjustmentsSection } from "./admin/EquityAdjustmentsSection";

export function Admin() {
  return (
    <section className="flex flex-1 flex-col gap-2 px-4 pt-8">
      <h1 className="mb-2 text-lg font-medium text-ink">Админка</h1>
      <BingxKeysSection />
      <AssetsSection />
      <RiskPlanSection />
      <EquityAdjustmentsSection />
    </section>
  );
}
