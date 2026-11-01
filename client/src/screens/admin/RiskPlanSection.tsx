import { useEffect, useState } from "react";
import {
  ApiError,
  getRiskLevels,
  getRiskSettings,
  getRiskStateAdmin,
  setRiskStateRequest,
  updateRiskLevelRequest,
  updateRiskSettingsRequest,
} from "../../api/client";
import type { RiskLevel, RiskSettings, RiskStateView } from "../../api/types";

export function RiskPlanSection() {
  const [levels, setLevels] = useState<RiskLevel[] | null>(null);
  const [settings, setSettings] = useState<RiskSettings | null>(null);
  const [state, setState] = useState<RiskStateView | null>(null);
  const [stateNotice, setStateNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getRiskLevels(), getRiskSettings(), getRiskStateAdmin()])
      .then(([levelsResult, settingsResult, stateResult]) => {
        setLevels(levelsResult);
        setSettings(settingsResult);
        setState(stateResult);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить риск-план"));
  }, []);

  /**
   * Ручная установка уровня и прогресса (01.11.2026): после переезда на другой хостинг
   * база поднялась пустой, и риск считался от первого уровня. Сохраняем обе цифры
   * разом — сервер проверяет их вместе (прогресс обязан быть меньше нормы уровня).
   */
  async function handleStateSave(patch: Partial<RiskStateView>) {
    if (!state) return;
    const next = { ...state, ...patch };
    setStateNotice(null);
    try {
      const updated = await setRiskStateRequest(next);
      setState(updated);
      setStateNotice("Сохранено");
    } catch (err) {
      setStateNotice(err instanceof ApiError ? err.message : "Не удалось сохранить состояние");
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
          {/* Состояние лестницы — отдельным блоком сверху: это не настройка, а факт
              прогресса, и правится он только вручную при восстановлении. */}
          {state && (
            <div className="flex flex-col gap-2 border-b border-line pb-2">
              <SettingRow
                label="Текущий уровень"
                value={state.currentLevel}
                onChange={(value) => handleStateSave({ currentLevel: value })}
              />
              <SettingRow
                label="Накоплено R на уровне"
                value={state.accumulatedR}
                onChange={(value) => handleStateSave({ accumulatedR: value })}
              />
              {stateNotice && (
                <p
                  className={`text-[11px] ${stateNotice === "Сохранено" ? "text-emerald-600" : "text-red-600"}`}
                >
                  {stateNotice}
                </p>
              )}
            </div>
          )}

          <SettingRow
            label="Кулдаун, кроме тейка (мин)"
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
