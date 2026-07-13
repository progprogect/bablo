import { useEffect, useState } from "react";
import {
  ApiError,
  getRiskLevels,
  getRiskSettings,
  updateRiskLevelRequest,
  updateRiskSettingsRequest,
} from "../../api/client";
import type { RiskLevel, RiskSettings } from "../../api/types";

export function RiskPlanSection() {
  const [levels, setLevels] = useState<RiskLevel[] | null>(null);
  const [settings, setSettings] = useState<RiskSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getRiskLevels(), getRiskSettings()])
      .then(([levelsResult, settingsResult]) => {
        setLevels(levelsResult);
        setSettings(settingsResult);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить риск-план"));
  }, []);

  async function handleLevelChange(level: RiskLevel, patch: { riskUsd?: number; requiredR?: number }) {
    try {
      const updated = await updateRiskLevelRequest(level.level, patch);
      setLevels((current) => current?.map((l) => (l.level === level.level ? updated : l)) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось обновить уровень");
    }
  }

  async function handleSettingsChange(patch: Partial<RiskSettings>) {
    try {
      const updated = await updateRiskSettingsRequest(patch);
      setSettings(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось обновить параметры");
    }
  }

  return (
    <section className="flex flex-col gap-3 pt-6">
      <h2 className="text-sm font-medium text-ink">Риск-план</h2>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {settings && (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-card p-3">
          <SettingRow
            label="Кулдаун после сделки (мин)"
            value={settings.cooldownMinutes}
            onChange={(value) => handleSettingsChange({ cooldownMinutes: value })}
          />
          <SettingRow
            label="Дневной лимит убытка (R)"
            value={settings.dailyLossLimitR}
            onChange={(value) => handleSettingsChange({ dailyLossLimitR: value })}
          />
          <SettingRow
            label="Дневная цель прибыли (R)"
            value={settings.dailyProfitLimitR}
            onChange={(value) => handleSettingsChange({ dailyProfitLimitR: value })}
          />
          <SettingRow
            label="Час сброса дня (0–23)"
            value={settings.resetHour}
            onChange={(value) => handleSettingsChange({ resetHour: value })}
          />
          <SettingRow
            label="Смещение таймзоны (мин от UTC)"
            value={settings.tzOffsetMinutes}
            onChange={(value) => handleSettingsChange({ tzOffsetMinutes: value })}
          />
        </div>
      )}

      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg border border-line bg-card p-2">
        {levels?.map((level) => (
          <div key={level.level} className="flex items-center gap-2 px-1 py-1 text-sm">
            <span className="w-6 text-slate-500">{level.level}</span>
            <input
              type="number"
              defaultValue={level.riskUsd}
              onBlur={(event) => handleLevelChange(level, { riskUsd: Number(event.target.value) })}
              className="w-20 rounded-md border border-line bg-transparent px-2 py-1 text-center text-ink outline-none focus:border-accent"
            />
            <span className="text-xs text-slate-500">USDT →</span>
            <input
              type="number"
              defaultValue={level.requiredR}
              onBlur={(event) => handleLevelChange(level, { requiredR: Number(event.target.value) })}
              className="w-16 rounded-md border border-line bg-transparent px-2 py-1 text-center text-ink outline-none focus:border-accent"
            />
            <span className="text-xs text-slate-500">R</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SettingRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-slate-500">{label}</span>
      <input
        type="number"
        defaultValue={value}
        onBlur={(event) => onChange(Number(event.target.value))}
        className="w-20 rounded-md border border-line bg-transparent px-2 py-1 text-center text-sm text-ink outline-none focus:border-accent"
      />
    </div>
  );
}
