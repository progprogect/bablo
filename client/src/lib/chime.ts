/**
 * Звук о закрытии сделки, когда приложение открыто (SSE `refresh` с reason
 * "trade.closed"). Всё синтезируется через Web Audio — без аудиофайлов в бандле, поэтому
 * набор звуков ничего не весит и работает офлайн.
 *
 * iOS разрешает звук только после жеста пользователя, поэтому AudioContext создаётся и
 * «разблокируется» на первом касании (initChimeUnlock) и дальше живёт до закрытия вкладки.
 * Если жеста ещё не было — сигнал молча пропускается: пуш всё равно придёт.
 *
 * ВАЖНО (ответ на вопрос от 20.09.2026): это звук ВНУТРИ открытого приложения. Звук
 * самого push-уведомления задаёт система — iOS не даёт веб-приложениям свой звук
 * уведомления, его можно менять только системно для всего устройства.
 */

let audioContext: AudioContext | null = null;

function ensureContext(): AudioContext | null {
  if (!audioContext) {
    try {
      audioContext = new AudioContext();
    } catch {
      return null;
    }
  }
  void audioContext.resume();
  return audioContext;
}

export function initChimeUnlock(): void {
  if (audioContext) return;
  const unlock = () => {
    ensureContext();
  };
  window.addEventListener("pointerdown", unlock, { once: true, passive: true });
  window.addEventListener("touchend", unlock, { once: true, passive: true });
}

type ToneOptions = {
  freq: number;
  /** Смещение от начала звука, секунды. */
  at?: number;
  duration?: number;
  type?: OscillatorType;
  volume?: number;
  /** Конечная частота — для «съезжающих» звуков вроде капли. */
  sweepTo?: number;
  /** Плавное нарастание вместо щелчка. */
  attack?: number;
};

function tone(context: AudioContext, startAt: number, options: ToneOptions): void {
  const {
    freq,
    at = 0,
    duration = 0.4,
    type = "triangle",
    volume = 0.5,
    sweepTo,
    attack = 0.01,
  } = options;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const begin = startAt + at;

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(freq, begin);
  if (sweepTo !== undefined) {
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(sweepTo, 1), begin + duration);
  }

  gain.gain.setValueAtTime(0, begin);
  gain.gain.linearRampToValueAtTime(volume, begin + attack);
  gain.gain.exponentialRampToValueAtTime(0.001, begin + duration);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(begin);
  oscillator.stop(begin + duration + 0.02);
}

export type ChimeSoundId = "ding" | "coin" | "bells" | "drop" | "soft";

export type ChimeSound = {
  id: ChimeSoundId;
  label: string;
  hint: string;
  play: (context: AudioContext, startAt: number) => void;
};

/** Набор звуков закрытия сделки. Порядок = порядок в настройках. */
export const CHIME_SOUNDS: ChimeSound[] = [
  {
    id: "ding",
    label: "Дзынь",
    hint: "Два восходящих тона — коротко и заметно",
    play: (context, at) => {
      tone(context, at, { freq: 1046.5, duration: 0.45 });
      tone(context, at, { freq: 1568, at: 0.18, duration: 0.6 });
    },
  },
  {
    id: "coin",
    label: "Монетка",
    hint: "Звонкая монета — как в старых играх",
    play: (context, at) => {
      tone(context, at, { freq: 988, duration: 0.08, type: "square", volume: 0.22 });
      tone(context, at, { freq: 1319, at: 0.07, duration: 0.4, type: "square", volume: 0.22 });
    },
  },
  {
    id: "bells",
    label: "Перезвон",
    hint: "Три ноты вверх — спокойный колокольчик",
    play: (context, at) => {
      tone(context, at, { freq: 784, duration: 0.5, type: "sine", volume: 0.45 });
      tone(context, at, { freq: 1046.5, at: 0.13, duration: 0.5, type: "sine", volume: 0.45 });
      tone(context, at, { freq: 1318.5, at: 0.26, duration: 0.7, type: "sine", volume: 0.45 });
    },
  },
  {
    id: "drop",
    label: "Капля",
    hint: "Мягкий «бульк» — почти не отвлекает",
    play: (context, at) => {
      tone(context, at, { freq: 960, duration: 0.28, type: "sine", volume: 0.5, sweepTo: 320 });
      tone(context, at, { freq: 640, at: 0.16, duration: 0.3, type: "sine", volume: 0.25, sweepTo: 260 });
    },
  },
  {
    id: "soft",
    label: "Тёплый",
    hint: "Плавный аккорд без резкой атаки",
    play: (context, at) => {
      tone(context, at, { freq: 659.3, duration: 0.9, type: "sine", volume: 0.4, attack: 0.06 });
      tone(context, at, { freq: 987.8, at: 0.05, duration: 0.9, type: "sine", volume: 0.3, attack: 0.08 });
    },
  },
];

const STORAGE_KEY = "bablo:chimeSound";
const DEFAULT_SOUND: ChimeSoundId = "ding";

/** Выбор звука — на устройстве: он про этот телефон, а не про аккаунт. */
export function getChimeSoundId(): ChimeSoundId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && CHIME_SOUNDS.some((sound) => sound.id === stored)) {
      return stored as ChimeSoundId;
    }
  } catch {
    // localStorage может быть недоступен (приватный режим) — звук по умолчанию.
  }
  return DEFAULT_SOUND;
}

export function setChimeSoundId(id: ChimeSoundId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Не смогли сохранить — звук останется выбранным до перезапуска приложения.
  }
}

function soundById(id: ChimeSoundId): ChimeSound {
  return CHIME_SOUNDS.find((sound) => sound.id === id) ?? CHIME_SOUNDS[0]!;
}

/** Сигнал о закрытии сделки выбранным звуком. Без «разблокированного» контекста молчит. */
export function playTradeClosedChime(): void {
  const context = audioContext;
  if (!context || context.state !== "running") return;
  soundById(getChimeSoundId()).play(context, context.currentTime);
}

/**
 * Проигрывает звук по требованию — из настроек, по нажатию. Жест пользователя позволяет
 * создать и разбудить контекст прямо здесь, поэтому предпрослушивание работает всегда.
 */
export function previewChime(id: ChimeSoundId): void {
  const context = ensureContext();
  if (!context) return;
  const start = () => soundById(id).play(context, context.currentTime + 0.02);
  if (context.state === "running") {
    start();
    return;
  }
  void context.resume().then(start).catch(() => {});
}
