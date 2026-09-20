import { useState } from "react";
import {
  CHIME_SOUNDS,
  getChimeSoundId,
  previewChime,
  setChimeSoundId,
  type ChimeSoundId,
} from "../../lib/chime";

function SelectedMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" aria-label="выбран">
      <circle cx="8" cy="8" r="8" className="fill-emerald-100" />
      <path
        d="M4.6 8.4 L7 10.8 L11.4 5.6"
        className="stroke-emerald-600"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Выбор звука, который звучит в ОТКРЫТОМ приложении при закрытии сделки (lib/chime.ts).
 * Нажатие сразу и выбирает звук, и проигрывает его — так слышно, что выбираешь, и заодно
 * это тот самый жест, который разрешает звук на iOS.
 *
 * Выбор хранится на устройстве (localStorage): звук — свойство этого телефона, а не
 * аккаунта, на разных устройствах он может быть разным.
 */
export function ChimeSoundPicker() {
  const [selected, setSelected] = useState<ChimeSoundId>(() => getChimeSoundId());

  function pick(id: ChimeSoundId) {
    setSelected(id);
    setChimeSoundId(id);
    previewChime(id);
  }

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div>
        <h2 className="text-sm font-medium text-ink">Звук закрытия сделки</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Звучит внутри открытого приложения. Нажми, чтобы послушать и выбрать — звук
          сохранится на этом устройстве.
        </p>
      </div>

      <ul className="flex flex-col gap-1.5">
        {CHIME_SOUNDS.map((sound) => {
          const isSelected = sound.id === selected;
          return (
            <li key={sound.id}>
              <button
                type="button"
                onClick={() => pick(sound.id)}
                className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition active:scale-[0.99] ${
                  isSelected ? "border-accent/40 bg-accent/5" : "border-line bg-surface"
                }`}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={`text-sm ${isSelected ? "font-medium text-ink" : "text-slate-700"}`}>
                    {sound.label}
                  </span>
                  <span className="text-[11px] leading-snug text-slate-500">{sound.hint}</span>
                </span>
                {isSelected ? (
                  <SelectedMark />
                ) : (
                  <span className="text-xs text-slate-400" aria-hidden="true">
                    ▶
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <p className="text-[11px] leading-snug text-slate-400">
        Звук самого push-уведомления (когда приложение закрыто) задаёт iPhone — веб-приложению
        свой звук уведомления система не разрешает. Его можно поменять только для всего
        телефона: Настройки → Звуки, тактильные сигналы.
      </p>
    </section>
  );
}
