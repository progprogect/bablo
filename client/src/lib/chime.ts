/**
 * Яркий звуковой сигнал о закрытии сделки, когда приложение открыто (SSE `refresh`
 * с reason "trade.closed"). Синтезируется через Web Audio — без аудиофайла в бандле.
 *
 * iOS разрешает звук только после жеста пользователя, поэтому AudioContext создаётся
 * и «разблокируется» на первом касании (initChimeUnlock) и дальше живёт до закрытия
 * вкладки. Если жеста ещё не было — сигнал молча пропускается, это осознанно:
 * пуш-уведомление всё равно придёт.
 */

let audioContext: AudioContext | null = null;

export function initChimeUnlock(): void {
  if (audioContext) return;
  const unlock = () => {
    if (!audioContext) {
      audioContext = new AudioContext();
    }
    // resume обязателен: контекст, созданный в обработчике жеста, стартует suspended.
    void audioContext.resume();
  };
  window.addEventListener("pointerdown", unlock, { once: true, passive: true });
  window.addEventListener("touchend", unlock, { once: true, passive: true });
}

function playTone(context: AudioContext, frequency: number, startAt: number, duration: number): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(0.5, startAt + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration);
}

/** Два восходящих тона (C6 → G6) — короткий и заметный «дзынь-дзынь». */
export function playTradeClosedChime(): void {
  const context = audioContext;
  if (!context || context.state !== "running") return;
  const now = context.currentTime;
  playTone(context, 1046.5, now, 0.45);
  playTone(context, 1568, now + 0.18, 0.6);
}
