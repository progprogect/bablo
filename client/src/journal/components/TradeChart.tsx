import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../api/http";
import { getTradeChart, saveDrawings } from "../api";
import type { ChartCandle, ChartDrawing, JournalTradeDetail, TradeChartResponse } from "../types";

/**
 * Рабочая зона графика сделки (запрос пользователя от 23.09.2026): свечи BingX из кэша
 * сервера, уровни сделки, пан/зум «как в TradingView» и рисование линий. Canvas без
 * библиотек — по прецеденту EquityChart (ручной SVG) и принципу «минимум зависимостей».
 *
 * Управление: перетаскивание — пан; колесо мыши и pinch двумя пальцами — зум по времени
 * (диапазон цен подстраивается под видимые свечи сам); режим «Линия» — провести
 * перетаскиванием; в обычном режиме тап по линии выделяет её, «Удалить» стирает.
 * Линии хранятся на сервере в координатах (время, цена) — не зависят от таймфрейма.
 */

type Interval = "15m" | "1h";

const CHART_HEIGHT = 320;
const PRICE_AXIS_WIDTH = 56;
const TIME_AXIS_HEIGHT = 20;
/** Минимум/максимум видимых свечей — пределы зума. */
const MIN_VISIBLE_CANDLES = 12;
const MAX_VISIBLE_CANDLES = 500;
/** Порог «это был тап, а не пан» и радиус попадания по линии, px. */
const TAP_THRESHOLD_PX = 5;
const HIT_RADIUS_PX = 8;

type Viewport = { t0: number; t1: number };

type DraftLine = { t1: number; p1: number; t2: number; p2: number };

/** Цвет из CSS-переменной темы ("--accent-rgb: 0 122 255") с альфой. */
function themeColor(name: string, alpha = 1): string {
  const triplet = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "0 0 0";
  return `rgb(${triplet.split(/\s+/).join(" ")} / ${alpha})`;
}

export function TradeChart({ trade }: { trade: JournalTradeDetail }) {
  const [interval, setIntervalKey] = useState<Interval>("15m");
  const [data, setData] = useState<TradeChartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [drawings, setDrawings] = useState<ChartDrawing[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [draft, setDraft] = useState<DraftLine | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // Живые ссылки для обработчиков указателя (не пересоздавать слушатели на каждый кадр).
  const stateRef = useRef({ viewport, data, drawings, drawMode, draft, selectedId });
  stateRef.current = { viewport, data, drawings, drawMode, draft, selectedId };

  // --- Загрузка данных ----------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    getTradeChart(trade.id, interval)
      .then((response) => {
        if (cancelled) return;
        setData(response);
        setDrawings(response.drawings);
        setViewport(initialViewport(response, trade));
        setSelectedId(null);
        setDraft(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Не удалось загрузить график");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [trade.id, interval]);

  function persistDrawings(next: ChartDrawing[]) {
    setDrawings(next);
    saveDrawings(trade.id, next).catch((err) => {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить линии");
    });
  }

  function deleteSelected() {
    if (!selectedId) return;
    persistDrawings(drawings.filter((line) => line.id !== selectedId));
    setSelectedId(null);
  }

  // --- Геометрия ------------------------------------------------------------------------------

  const plot = useCallback((widthCss: number) => {
    return {
      left: 0,
      top: 6,
      width: Math.max(widthCss - PRICE_AXIS_WIDTH, 10),
      height: CHART_HEIGHT - TIME_AXIS_HEIGHT - 12,
    };
  }, []);

  const priceRange = useMemo(() => {
    if (!data || !viewport) return null;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const candle of data.candles) {
      if (candle.t + data.stepMs < viewport.t0 || candle.t > viewport.t1) continue;
      min = Math.min(min, candle.l);
      max = Math.max(max, candle.h);
    }
    // Уровни сделки — смысл графика: держим их в кадре всегда.
    for (const level of [trade.entryPrice, trade.initialSlPrice, trade.plannedTpPrice, trade.closePrice]) {
      if (level !== null) {
        min = Math.min(min, level);
        max = Math.max(max, level);
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return null;
    const pad = (max - min) * 0.06;
    return { min: min - pad, max: max + pad };
  }, [data, viewport, trade]);

  // --- Отрисовка ------------------------------------------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || !data || !viewport || !priceRange) return;

    const widthCss = wrap.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(widthCss * dpr);
    canvas.height = Math.round(CHART_HEIGHT * dpr);
    canvas.style.width = `${widthCss}px`;
    canvas.style.height = `${CHART_HEIGHT}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const area = plot(widthCss);
    const { t0, t1 } = viewport;
    const xFor = (t: number) => area.left + ((t - t0) / (t1 - t0)) * area.width;
    const yFor = (p: number) =>
      area.top + area.height - ((p - priceRange.min) / (priceRange.max - priceRange.min)) * area.height;

    const ink = themeColor("--ink-rgb", 0.9);
    const muted = themeColor("--muted-rgb", 0.9);
    const line = themeColor("--line-rgb", 1);
    const accent = themeColor("--accent-rgb", 1);
    const positive = themeColor("--positive-rgb", 1);
    const negative = themeColor("--negative-rgb", 1);

    ctx.clearRect(0, 0, widthCss, CHART_HEIGHT);
    ctx.font = "10px -apple-system, system-ui, sans-serif";

    // Сетка и ось цен: 5 «круглых» уровней.
    const ticks = priceTicks(priceRange.min, priceRange.max, 5);
    ctx.strokeStyle = themeColor("--line-rgb", 0.6);
    ctx.fillStyle = muted;
    ctx.lineWidth = 1;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const tick of ticks) {
      const y = Math.round(yFor(tick)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(area.left, y);
      ctx.lineTo(area.left + area.width, y);
      ctx.stroke();
      ctx.fillText(formatTick(tick), area.left + area.width + 6, y);
    }

    // Ось времени: метки примерно каждые 90px.
    const msPerPx = (t1 - t0) / area.width;
    const labelEveryMs = niceTimeStep(msPerPx * 90);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let t = Math.ceil(t0 / labelEveryMs) * labelEveryMs; t <= t1; t += labelEveryMs) {
      const x = xFor(t);
      ctx.fillStyle = muted;
      ctx.fillText(formatTime(t, labelEveryMs), x, area.top + area.height + 6);
    }

    // Всё содержимое области — под клипом: полувидимые свечи и линии пользователя
    // не должны выезжать на оси и поля карточки.
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.left, area.top, area.width, area.height);
    ctx.clip();

    // Свечи.
    const bodyWidth = Math.max(Math.min((data.stepMs / (t1 - t0)) * area.width * 0.7, 13), 1);
    for (const candle of data.candles) {
      if (candle.t + data.stepMs < t0 || candle.t > t1) continue;
      const x = xFor(candle.t + data.stepMs / 2);
      const color = candle.c >= candle.o ? positive : negative;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yFor(candle.h));
      ctx.lineTo(x, yFor(candle.l));
      ctx.stroke();
      const yOpen = yFor(candle.o);
      const yClose = yFor(candle.c);
      const top = Math.min(yOpen, yClose);
      const height = Math.max(Math.abs(yOpen - yClose), 1);
      ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, height);
    }

    // Уровни сделки: вход / стоп при входе / тейк-план / закрытие.
    const levels: { price: number | null; color: string; dash: number[]; label: string }[] = [
      { price: trade.entryPrice, color: accent, dash: [], label: "вход" },
      { price: trade.initialSlPrice, color: negative, dash: [4, 3], label: "SL" },
      { price: trade.plannedTpPrice, color: positive, dash: [4, 3], label: "TP" },
    ];
    for (const level of levels) {
      if (level.price === null) continue;
      const y = Math.round(yFor(level.price)) + 0.5;
      ctx.strokeStyle = level.color;
      ctx.setLineDash(level.dash);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(area.left, y);
      ctx.lineTo(area.left + area.width, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = level.color;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(level.label, area.left + 4, y - 2);
    }

    // Моменты входа/выхода: вертикальные штрихи + маркеры на ценах.
    const openedMs = new Date(trade.openedAt).getTime();
    const closedMs = trade.closedAt ? new Date(trade.closedAt).getTime() : null;
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = themeColor("--muted-rgb", 0.55);
    for (const t of [openedMs, closedMs]) {
      if (t === null || t < t0 || t > t1) continue;
      const x = Math.round(xFor(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.top + area.height);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (trade.entryPrice !== null && openedMs >= t0 && openedMs <= t1) {
      drawTriangle(ctx, xFor(openedMs), yFor(trade.entryPrice), trade.side === "long", accent);
    }
    if (trade.closePrice !== null && closedMs !== null && closedMs >= t0 && closedMs <= t1) {
      const color = trade.resultUsd !== null && trade.resultUsd < 0 ? negative : positive;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(xFor(closedMs), yFor(trade.closePrice), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Линии пользователя.
    for (const drawing of drawings) {
      const isSelected = drawing.id === selectedId;
      ctx.strokeStyle = isSelected ? accent : themeColor("--accent-rgb", 0.75);
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(xFor(drawing.t1), yFor(drawing.p1));
      ctx.lineTo(xFor(drawing.t2), yFor(drawing.p2));
      ctx.stroke();
      if (isSelected) {
        ctx.fillStyle = accent;
        for (const [t, p] of [
          [drawing.t1, drawing.p1],
          [drawing.t2, drawing.p2],
        ] as const) {
          ctx.beginPath();
          ctx.arc(xFor(t), yFor(p), 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    if (draft) {
      ctx.strokeStyle = accent;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xFor(draft.t1), yFor(draft.p1));
      ctx.lineTo(xFor(draft.t2), yFor(draft.p2));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();

    // Рамка области.
    ctx.strokeStyle = line;
    ctx.strokeRect(area.left + 0.5, area.top + 0.5, area.width - 1, area.height - 1);
    void ink;
  }, [data, viewport, priceRange, drawings, selectedId, draft, trade, plot]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [draw]);

  // --- Взаимодействие: пан, зум, pinch, рисование ---------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pointers = new Map<number, { x: number; y: number }>();
    let panState: { startX: number; startViewport: Viewport; moved: boolean } | null = null;
    let pinchState: { startDistance: number; startViewport: Viewport; centerT: number } | null = null;
    let drawStart: { t: number; p: number; x: number; y: number } | null = null;

    const rectOf = () => canvas.getBoundingClientRect();

    function toChart(clientX: number, clientY: number) {
      const rect = rectOf();
      const { viewport: vp } = stateRef.current;
      const widthCss = rect.width;
      const area = plot(widthCss);
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      if (!vp || !priceRangeRef.current) return { x, y, t: 0, p: 0, area };
      const t = vp.t0 + ((x - area.left) / area.width) * (vp.t1 - vp.t0);
      const pr = priceRangeRef.current;
      const p = pr.min + ((area.top + area.height - y) / area.height) * (pr.max - pr.min);
      return { x, y, t, p, area };
    }

    function clampViewport(next: Viewport): Viewport {
      const { data: d } = stateRef.current;
      if (!d) return next;
      const step = d.stepMs;
      const dataFrom = d.range.fromMs - step * 20;
      const dataTo = d.range.toMs + step * 20;
      let span = next.t1 - next.t0;
      span = Math.min(Math.max(span, step * MIN_VISIBLE_CANDLES), step * MAX_VISIBLE_CANDLES);
      let t0 = next.t0;
      if (t0 < dataFrom) t0 = dataFrom;
      if (t0 + span > dataTo) t0 = Math.max(dataTo - span, dataFrom);
      return { t0, t1: t0 + span };
    }

    function zoomAround(centerT: number, factor: number) {
      const { viewport: vp } = stateRef.current;
      if (!vp) return;
      const span = (vp.t1 - vp.t0) * factor;
      const ratio = (centerT - vp.t0) / (vp.t1 - vp.t0);
      setViewport(clampViewport({ t0: centerT - span * ratio, t1: centerT + span * (1 - ratio) }));
    }

    function onPointerDown(event: PointerEvent) {
      (event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const st = stateRef.current;
      if (pointers.size === 2) {
        // Pinch: пан/рисование отменяются, масштабируем вокруг центра щипка.
        const [a, b] = [...pointers.values()];
        if (!a || !b || !st.viewport) return;
        panState = null;
        drawStart = null;
        setDraft(null);
        const center = toChart((a.x + b.x) / 2, (a.y + b.y) / 2);
        pinchState = {
          startDistance: Math.hypot(a.x - b.x, a.y - b.y),
          startViewport: st.viewport,
          centerT: center.t,
        };
        return;
      }
      if (!st.viewport) return;
      if (st.drawMode) {
        const point = toChart(event.clientX, event.clientY);
        drawStart = { t: point.t, p: point.p, x: point.x, y: point.y };
        setDraft({ t1: point.t, p1: point.p, t2: point.t, p2: point.p });
      } else {
        panState = { startX: event.clientX, startViewport: st.viewport, moved: false };
      }
    }

    function onPointerMove(event: PointerEvent) {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const st = stateRef.current;

      if (pinchState && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        if (!a || !b) return;
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (distance < 10) return;
        const factor = pinchState.startDistance / distance;
        const sv = pinchState.startViewport;
        const span = (sv.t1 - sv.t0) * factor;
        const ratio = (pinchState.centerT - sv.t0) / (sv.t1 - sv.t0);
        setViewport(
          clampViewport({
            t0: pinchState.centerT - span * ratio,
            t1: pinchState.centerT + span * (1 - ratio),
          }),
        );
        return;
      }

      if (drawStart && st.drawMode) {
        const point = toChart(event.clientX, event.clientY);
        setDraft({ t1: drawStart.t, p1: drawStart.p, t2: point.t, p2: point.p });
        return;
      }

      if (panState && st.viewport) {
        const rect = rectOf();
        const area = plot(rect.width);
        const dx = event.clientX - panState.startX;
        if (Math.abs(dx) > TAP_THRESHOLD_PX) panState.moved = true;
        const sv = panState.startViewport;
        const msPerPx = (sv.t1 - sv.t0) / area.width;
        setViewport(clampViewport({ t0: sv.t0 - dx * msPerPx, t1: sv.t1 - dx * msPerPx }));
      }
    }

    function onPointerUp(event: PointerEvent) {
      const st = stateRef.current;
      pointers.delete(event.pointerId);
      if (pinchState && pointers.size < 2) pinchState = null;

      if (drawStart && st.drawMode) {
        const point = toChart(event.clientX, event.clientY);
        const distance = Math.hypot(point.x - drawStart.x, point.y - drawStart.y);
        if (distance > TAP_THRESHOLD_PX) {
          const drawing: ChartDrawing = {
            id: `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
            t1: drawStart.t,
            p1: drawStart.p,
            t2: point.t,
            p2: point.p,
          };
          persistDrawingsRef.current([...stateRef.current.drawings, drawing]);
        }
        drawStart = null;
        setDraft(null);
        return;
      }

      if (panState) {
        if (!panState.moved) {
          // Тап в режиме пана — выбор линии под пальцем/курсором (радиус в пикселях).
          const rect = rectOf();
          const area = plot(rect.width);
          const vp = stateRef.current.viewport;
          const pr = priceRangeRef.current;
          if (vp && pr) {
            const xFor = (t: number) => area.left + ((t - vp.t0) / (vp.t1 - vp.t0)) * area.width;
            const yFor = (p: number) =>
              area.top + area.height - ((p - pr.min) / (pr.max - pr.min)) * area.height;
            const px = event.clientX - rect.left;
            const py = event.clientY - rect.top;
            let bestId: string | null = null;
            let bestDistance = Number.POSITIVE_INFINITY;
            for (const drawing of stateRef.current.drawings) {
              const distance = distanceToSegmentPx(
                px,
                py,
                xFor(drawing.t1),
                yFor(drawing.p1),
                xFor(drawing.t2),
                yFor(drawing.p2),
              );
              if (distance < bestDistance) {
                bestDistance = distance;
                bestId = drawing.id;
              }
            }
            setSelectedId(bestDistance <= HIT_RADIUS_PX ? bestId : null);
          }
        }
        panState = null;
      }
    }

    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const point = toChart(event.clientX, event.clientY);
      zoomAround(point.t, Math.exp(event.deltaY * 0.0015));
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plot]);

  // Живые ссылки для слушателей (создаются один раз).
  const priceRangeRef = useRef(priceRange);
  priceRangeRef.current = priceRange;
  const persistDrawingsRef = useRef(persistDrawings);
  persistDrawingsRef.current = persistDrawings;

  // --- Разметка -------------------------------------------------------------------------------

  return (
    <div className="mx-4 flex flex-col gap-2 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1.5">
          <ToolChip label="15м" active={interval === "15m"} onClick={() => setIntervalKey("15m")} />
          <ToolChip label="1ч" active={interval === "1h"} onClick={() => setIntervalKey("1h")} />
        </div>
        <div className="flex items-center gap-1.5">
          {selectedId && (
            <button type="button" onClick={deleteSelected} className="rounded-full px-3 py-1.5 text-xs font-medium text-negative">
              Удалить линию
            </button>
          )}
          <ToolChip
            label="Линия"
            icon={<PencilMiniIcon />}
            active={drawMode}
            onClick={() => {
              setDrawMode((mode) => !mode);
              setSelectedId(null);
            }}
          />
        </div>
      </div>

      <div ref={wrapRef} className="relative w-full" style={{ height: CHART_HEIGHT }}>
        {isLoading && (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-muted">Загрузка…</p>
        )}
        {!isLoading && data !== null && data.candles.length === 0 && (
          <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-muted">
            Свечей за этот период у биржи уже нет — график недоступен.
          </p>
        )}
        <canvas
          ref={canvasRef}
          className={drawMode ? "cursor-crosshair touch-none" : "cursor-grab touch-none active:cursor-grabbing"}
        />
      </div>

      {error && <p className="text-xs text-negative">{error}</p>}
      <p className="text-[11px] leading-4 text-muted">
        Перетаскивание — движение, колесо или щипок — масштаб. «Линия» — провести по графику;
        тап по линии выделяет её.
      </p>
    </div>
  );
}

function ToolChip({
  label,
  active,
  onClick,
  icon,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-xs ${
        active ? "bg-accent font-medium text-white" : "border border-line bg-card text-muted"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function PencilMiniIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 20h4l11-11a2.1 2.1 0 0 0-4-4L4 16v4Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// --- Хелперы ---------------------------------------------------------------------------------

/** Стартовый вид: сделка целиком + контекст слева и немного после закрытия. */
function initialViewport(response: TradeChartResponse, trade: JournalTradeDetail): Viewport {
  const openedMs = new Date(trade.openedAt).getTime();
  const closedMs = trade.closedAt ? new Date(trade.closedAt).getTime() : openedMs;
  const step = response.stepMs;
  const t0 = openedMs - step * 40;
  const t1 = closedMs + step * 12;
  return { t0: Math.max(t0, response.range.fromMs), t1: Math.min(t1, response.range.toMs + step) };
}

/** «Круглые» ценовые деления: 1/2/2.5/5 × 10^k, покрывающие диапазон count делениями. */
function priceTicks(min: number, max: number, count: number): number[] {
  const rawStep = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * magnitude);
  const step = candidates.find((candidate) => candidate >= rawStep) ?? candidates[candidates.length - 1]!;
  const ticks: number[] = [];
  for (let tick = Math.ceil(min / step) * step; tick <= max; tick += step) ticks.push(tick);
  return ticks;
}

function formatTick(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 1 : abs >= 10 ? 2 : abs >= 0.1 ? 4 : 6;
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

/** Шаг подписей времени: круглые интервалы от 5 минут до суток. */
function niceTimeStep(roughMs: number): number {
  const steps = [
    5 * 60_000,
    15 * 60_000,
    30 * 60_000,
    3_600_000,
    2 * 3_600_000,
    4 * 3_600_000,
    6 * 3_600_000,
    12 * 3_600_000,
    24 * 3_600_000,
  ];
  return steps.find((step) => step >= roughMs) ?? steps[steps.length - 1]!;
}

function formatTime(t: number, stepMs: number): string {
  const date = new Date(t);
  if (stepMs >= 24 * 3_600_000) {
    return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  }
  const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  // Начало суток подписываем датой — иначе при многодневном окне все метки «во сколько».
  return date.getHours() === 0 && date.getMinutes() === 0
    ? date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })
    : time;
}

function drawTriangle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  pointingUp: boolean,
  color: string,
): void {
  const size = 5;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (pointingUp) {
    ctx.moveTo(x, y - size);
    ctx.lineTo(x - size, y + size);
    ctx.lineTo(x + size, y + size);
  } else {
    ctx.moveTo(x, y + size);
    ctx.lineTo(x - size, y - size);
    ctx.lineTo(x + size, y - size);
  }
  ctx.closePath();
  ctx.fill();
}

/** Расстояние от точки до отрезка в пикселях экрана — hit-test выбора линии. */
function distanceToSegmentPx(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const clamped = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + clamped * dx), py - (ay + clamped * dy));
}
