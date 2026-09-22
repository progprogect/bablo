import { useEffect, useState } from "react";
import {
  ApiError,
  getManualHourBlocks,
  getRiskLevels,
  getRiskSettings,
  releaseManualHourBlockRequest,
  updateRiskLevelRequest,
  updateRiskSettingsRequest,
} from "../../api/client";
import type { ManualHourBlock, RiskLevel, RiskSettings } from "../../api/types";

export function RiskPlanSection() {
  const [levels, setLevels] = useState<RiskLevel[] | null>(null);
  const [settings, setSettings] = useState<RiskSettings | null>(null);
  const [manualHours, setManualHours] = useState<ManualHourBlock[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getRiskLevels(), getRiskSettings(), getManualHourBlocks()])
      .then(([levelsResult, settingsResult, manualResult]) => {
        setLevels(levelsResult);
        setSettings(settingsResult);
        setManualHours(manualResult);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить риск-план"));
  }, []);

  async function handleReleaseHour(hour: number) {
    try {
      await releaseManualHourBlockRequest(hour);
      setManualHours((current) => current.filter((entry) => entry.hour !== hour));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось открыть час");
    }
  }

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
          {/* Выключатель правила убыточных часов (docs/RISK_ENGINE.md): набор закрытых часов
              продолжает считаться, но блокировка открытия и метки в подсказке пропадают. */}
          <ToggleRow
            label="Блокировать убыточные часы"
            value={settings.blockLosingHours}
            onChange={(value) => handleSettingsChange({ blockLosingHours: value })}
          />
        </div>
      )}

      {/* Часы, закрытые вручную (docs/RISK_ENGINE.md, правило #10). Их не снимает ни
          гистерезис, ни пересчёт — только своя проверка винрейта, а после подтверждённой
          гипотезы не снимает и она. Эта строка — единственный способ открыть такой час,
          не выключая правило целиком. */}
      {manualHours.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg border border-line bg-card p-3">
          <span className="text-xs text-slate-500">Закрыты вручную</span>
          {manualHours.map((entry) => (
            <div key={entry.hour} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-ink">
                {entry.hour}:00
                <span className="ml-2 text-xs text-slate-500">
                  {entry.reviewed ? "проверка пройдена" : "ждёт проверки винрейта"}
                </span>
              </span>
              <button
                type="button"
                onClick={() => handleReleaseHour(entry.hour)}
                className="text-xs font-medium text-accent underline-offset-2 hover:underline"
              >
                открыть
              </button>
            </div>
          ))}
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

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-slate-500">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={
          value
            ? "rounded-md bg-accent/15 px-2 py-1 text-xs text-accent"
            : "rounded-md bg-slate-200 px-2 py-1 text-xs text-slate-500"
        }
      >
        {value ? "включено" : "выключено"}
      </button>
    </div>
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
