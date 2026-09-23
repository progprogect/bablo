import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../../api/http";
import { formatPrice, formatSignedUsd, trimTrailingZeros } from "../../lib/format";
import { getCategories, getJournalTrade, removeEntry, saveEntry } from "../api";
import { DetailList, DetailRow } from "../components/DetailRow";
import { StarsInput, StarsView } from "../components/Stars";
import { OUTCOME_LABELS, SideBadge } from "../components/TradeCard";
import type {
  AnswerValue,
  ConstructorCategory,
  EntryBlock,
  JournalTradeDetail,
} from "../types";

/**
 * Деталь сделки: «картина сделки» в духе карточки активной сделки терминала (вход, стоп
 * и тейк ПРИ ВХОДЕ с суммами, факт закрытия), блок данных для анализа (MFE и безубыток —
 * их собирает трекер терминала, и журнал — первое место, где они видны) и разбор:
 * категория + обязательный чек-лист.
 */
export function TradeDetail() {
  const { id } = useParams();
  const tradeId = Number(id);
  const [trade, setTrade] = useState<JournalTradeDetail | null>(null);
  const [entry, setEntry] = useState<EntryBlock | null>(null);
  const [categories, setCategories] = useState<ConstructorCategory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getJournalTrade(tradeId), getCategories()])
      .then(([detail, cats]) => {
        if (cancelled) return;
        setTrade(detail.trade);
        setEntry(detail.entry);
        setCategories(cats.categories);
        setIsEditing(detail.entry === null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Не удалось загрузить сделку");
      });
    return () => {
      cancelled = true;
    };
  }, [tradeId]);

  if (error) {
    return (
      <section className="flex flex-1 flex-col gap-4 pt-10">
        <BackLink />
        <p className="px-6 text-center text-sm text-negative">{error}</p>
      </section>
    );
  }
  if (!trade) {
    return (
      <section className="flex flex-1 items-center justify-center px-6 text-sm text-muted">
        Загрузка…
      </section>
    );
  }

  const displayName = trade.symbol.replace(/-USDT$/, "");

  return (
    <section className="flex flex-1 flex-col gap-4 pt-10 pb-4">
      <BackLink />

      {/* Шапка */}
      <div className="mx-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium text-ink">{displayName}</h1>
          <SideBadge side={trade.side} />
        </div>
        <span className="text-xs text-muted">{formatDateTime(trade.openedAt)}</span>
      </div>

      <TradePicture trade={trade} />
      <AnalysisData trade={trade} />

      {isEditing ? (
        <EntryForm
          tradeId={trade.id}
          categories={categories}
          entry={entry}
          onSaved={(saved) => {
            setTrade(saved.trade);
            setEntry(saved.entry);
            setIsEditing(false);
          }}
          onCancel={entry !== null ? () => setIsEditing(false) : undefined}
        />
      ) : (
        entry && (
          <EntryView
            entry={entry}
            onEdit={() => setIsEditing(true)}
            onRemove={async () => {
              if (!window.confirm("Убрать сделку из категории? Ответы на чек-лист будут удалены.")) return;
              try {
                await removeEntry(trade.id);
                setEntry(null);
                setIsEditing(true);
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "Не удалось убрать разбор");
              }
            }}
          />
        )
      )}
    </section>
  );
}

function BackLink() {
  return (
    <Link to="/" className="flex items-center gap-1 px-4 text-sm text-accent">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M14.5 5 8 12l6.5 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Разбор
    </Link>
  );
}

/** Картина сделки: план входа и факт закрытия — те же уровни, что при открытии в терминале. */
function TradePicture({ trade }: { trade: JournalTradeDetail }) {
  const outcomeLabel = OUTCOME_LABELS[trade.outcome];
  const isProfit = trade.resultUsd !== null && trade.resultUsd > 0;
  const isLoss = trade.resultUsd !== null && trade.resultUsd < 0;
  const slMoved =
    trade.finalSlPrice !== null &&
    trade.initialSlPrice !== null &&
    Math.abs(trade.finalSlPrice - trade.initialSlPrice) > Math.abs(trade.initialSlPrice) * 1e-9;

  return (
    <div className="mx-4 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <DetailList>
        <DetailRow label="Вход" value={formatPrice(trade.entryPrice)} />
        <DetailRow
          label="Стоп при входе"
          value={formatPrice(trade.initialSlPrice)}
          hint={trade.riskUsd !== null ? `−${formatPrice(trade.riskUsd, 2)} USDT · 1R` : undefined}
          hintTone="negative"
        />
        <DetailRow
          label="Тейк (план)"
          value={formatPrice(trade.plannedTpPrice)}
          hint={
            trade.plannedProfitUsd !== null && trade.plannedRR !== null
              ? `+${formatPrice(trade.plannedProfitUsd, 2)} USDT · R/R 1/${trimTrailingZeros(trade.plannedRR, 1)}`
              : undefined
          }
          hintTone="positive"
        />
        {slMoved && (
          <DetailRow
            label="Стоп в конце"
            value={formatPrice(trade.finalSlPrice)}
            hint="подтянут в ходе сделки"
          />
        )}
      </DetailList>

      {/* Итог — единственная акцентная строка карточки, сумма справа осознанно:
          однострочное число с правым краем сравнивать удобно, это не многострочный текст. */}
      <div className="mt-2 flex items-baseline justify-between border-t border-line pt-3">
        <span className="text-xs text-muted">
          Закрытие <span className="tabular-nums">{formatPrice(trade.closePrice)}</span>
          {outcomeLabel ? ` · ${outcomeLabel}` : ""}
        </span>
        <span
          className={`text-base font-semibold tabular-nums ${isProfit ? "text-positive" : isLoss ? "text-negative" : "text-ink"}`}
        >
          {formatSignedUsd(trade.resultUsd)}
        </span>
      </div>
      {trade.statsResultR !== null && trade.statsResultR !== 0 && (
        <p className="text-right text-xs text-muted">факт {formatRWithSign(trade.statsResultR)}</p>
      )}
    </div>
  );
}

/** Данные для анализа: то, что трекер собирает по каждой сделке (MFE, безубыток) + параметры. */
function AnalysisData({ trade }: { trade: JournalTradeDetail }) {
  const openedHour = new Date(trade.openedAt).getHours();
  return (
    <div className="mx-4 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Для анализа</p>
      <DetailList>
        <DetailRow
          label="Лучший ход (MFE)"
          value={
            trade.mfeR !== null
              ? `${formatRWithSign(trade.mfeR)} (${formatPrice(trade.mfePrice)})`
              : "—"
          }
        />
        <DetailRow
          label="Возврат к безубытку"
          value={trade.beCrossed ? "Был" : "Не было"}
          hint={trade.beCrossed ? "цена сходила в плюс и вернулась к входу" : undefined}
        />
        <DetailRow label="Длительность" value={formatDuration(trade.openedAt, trade.closedAt)} />
        <DetailRow label="Час открытия" value={`${openedHour}ч`} />
        <DetailRow
          label="Объём"
          value={trade.quantity !== null ? `${trimTrailingZeros(trade.quantity, 4)} монет` : "—"}
        />
        <DetailRow label="Плечо" value={`${trade.leverage}×`} />
        <DetailRow
          label="Маржа"
          value={trade.marginUsd !== null ? `${formatPrice(trade.marginUsd, 2)} USDT` : "—"}
        />
      </DetailList>
    </div>
  );
}

// --- Разбор: просмотр и форма -------------------------------------------------------------

function EntryView({
  entry,
  onEdit,
  onRemove,
}: {
  entry: EntryBlock;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="mx-4 flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Разбор</p>
        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
          {entry.categoryName}
          {entry.categoryArchived ? " (архив)" : ""}
        </span>
      </div>

      <DetailList>
        {entry.answers.map((answer) => (
          <DetailRow
            key={answer.itemId}
            label={answer.label + (answer.itemArchived ? " (архив)" : "")}
            value={<AnswerValueView type={answer.answerType} value={answer.value} />}
          />
        ))}
      </DetailList>
      {entry.answers.length === 0 && (
        <p className="text-xs text-muted">У чек-листа категории нет пунктов.</p>
      )}

      <div className="mt-1 flex items-center justify-between">
        <button type="button" onClick={onEdit} className="rounded-xl border border-line px-3.5 py-2 text-sm text-ink">
          Изменить разбор
        </button>
        <button type="button" onClick={onRemove} className="text-xs text-negative">
          Убрать из категории
        </button>
      </div>
    </div>
  );
}

function AnswerValueView({ type, value }: { type: string; value: AnswerValue | null }) {
  if (value === null) return <span className="text-sm text-muted">—</span>;
  if (type === "yes_no") {
    return typeof value === "boolean" && value ? (
      <span className="text-sm font-medium text-positive">Да</span>
    ) : (
      <span className="text-sm font-medium text-negative">Нет</span>
    );
  }
  if (type === "scale_0_10") {
    return <span className="text-sm font-medium text-ink">{String(value)} / 10</span>;
  }
  if (type === "stars_0_5" && typeof value === "number") {
    return <StarsView value={value} />;
  }
  return <span className="text-sm text-ink">{String(value)}</span>;
}

/**
 * Форма разбора. Ответить нужно на ВСЕ пункты чек-листа выбранной категории — кнопка
 * активируется только с полным набором, сервер валидирует то же самое ещё раз.
 */
function EntryForm({
  tradeId,
  categories,
  entry,
  onSaved,
  onCancel,
}: {
  tradeId: number;
  categories: ConstructorCategory[];
  entry: EntryBlock | null;
  onSaved: (saved: { trade: JournalTradeDetail; entry: EntryBlock | null }) => void;
  onCancel?: () => void;
}) {
  const [categoryId, setCategoryId] = useState<number | null>(
    entry && !entry.categoryArchived ? entry.categoryId : null,
  );
  const [draft, setDraft] = useState<Map<number, AnswerValue>>(() => prefill(entry));
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const selected = useMemo(
    () => categories.find((category) => category.id === categoryId) ?? null,
    [categories, categoryId],
  );
  const isComplete = selected !== null && selected.items.every((item) => isAnswered(draft.get(item.id), item.answerType));

  function selectCategory(id: number) {
    setCategoryId(id);
    // Ответы принадлежат чек-листу категории: при смене категории черновик начинается
    // заново (кроме возврата к категории сохранённого разбора — там префилл).
    setDraft(entry && entry.categoryId === id ? prefill(entry) : new Map());
    setError(null);
  }

  function setAnswer(itemId: number, value: AnswerValue) {
    setDraft((current) => {
      const next = new Map(current);
      next.set(itemId, value);
      return next;
    });
  }

  async function save() {
    if (!selected) return;
    setIsSaving(true);
    setError(null);
    try {
      const answers = selected.items.map((item) => ({ itemId: item.id, value: draft.get(item.id)! }));
      const saved = await saveEntry(tradeId, selected.id, answers);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить разбор");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="mx-4 flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">Разбор</p>

      {categories.length === 0 ? (
        <p className="text-sm text-muted">
          Пока нет ни одной категории. Создай их в{" "}
          <Link to="/settings" className="font-medium text-accent">
            настройках анализа
          </Link>
          {" "}— затем сделку можно будет разобрать.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => selectCategory(category.id)}
                className={`rounded-full px-3.5 py-1.5 text-sm ${
                  category.id === categoryId
                    ? "bg-accent font-medium text-white"
                    : "border border-line bg-card text-muted"
                }`}
              >
                {category.name}
              </button>
            ))}
          </div>

          {selected && (
            <div className="flex flex-col gap-3">
              {selected.items.map((item) => (
                <ChecklistField
                  key={item.id}
                  label={item.label}
                  answerType={item.answerType}
                  value={draft.get(item.id)}
                  onChange={(value) => setAnswer(item.id, value)}
                />
              ))}
              {selected.items.length === 0 && (
                <p className="text-xs text-muted">
                  У этой категории нет пунктов чек-листа — сделка сохранится без ответов.
                </p>
              )}
            </div>
          )}

          {error && <p className="text-xs text-negative">{error}</p>}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={!isComplete || isSaving}
              className="flex-1 rounded-xl bg-accent py-2.5 text-sm font-medium text-white disabled:opacity-40"
            >
              {isSaving ? "Сохраняю…" : "Сохранить разбор"}
            </button>
            {onCancel && (
              <button type="button" onClick={onCancel} className="rounded-xl border border-line px-3.5 py-2.5 text-sm text-muted">
                Отмена
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ChecklistField({
  label,
  answerType,
  value,
  onChange,
}: {
  label: string;
  answerType: string;
  value: AnswerValue | undefined;
  onChange: (value: AnswerValue) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">{label}</span>
      {answerType === "yes_no" && (
        <div className="flex gap-1.5">
          <ChoiceChip label="Да" active={value === true} onClick={() => onChange(true)} />
          <ChoiceChip label="Нет" active={value === false} onClick={() => onChange(false)} />
        </div>
      )}
      {answerType === "scale_0_10" && (
        <div className="grid grid-cols-6 gap-1.5">
          {Array.from({ length: 11 }, (_, score) => (
            <ChoiceChip
              key={score}
              label={String(score)}
              active={value === score}
              onClick={() => onChange(score)}
              narrow
            />
          ))}
        </div>
      )}
      {answerType === "stars_0_5" && (
        <StarsInput value={typeof value === "number" ? value : undefined} onChange={onChange} />
      )}
      {answerType === "text" && (
        <textarea
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          rows={2}
          placeholder="Текст…"
          className="w-full rounded-xl border border-line bg-card p-3 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
        />
      )}
    </div>
  );
}

function ChoiceChip({
  label,
  active,
  onClick,
  narrow = false,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  narrow?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full py-1.5 text-sm ${narrow ? "w-full px-0 text-center" : "px-4"} ${
        active ? "bg-accent font-medium text-white" : "border border-line bg-card text-muted"
      }`}
    >
      {label}
    </button>
  );
}

// --- Хелперы -------------------------------------------------------------------------------

function prefill(entry: EntryBlock | null): Map<number, AnswerValue> {
  const map = new Map<number, AnswerValue>();
  for (const answer of entry?.answers ?? []) {
    if (answer.value !== null && !answer.itemArchived) map.set(answer.itemId, answer.value);
  }
  return map;
}

function isAnswered(value: AnswerValue | undefined, answerType: string): boolean {
  if (value === undefined) return false;
  if (answerType === "text") return typeof value === "string" && value.trim().length > 0;
  return true;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(openedAt: string, closedAt: string | null): string {
  if (!closedAt) return "—";
  const ms = new Date(closedAt).getTime() - new Date(openedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
}

/** R с одной цифрой после запятой и знаком: 2.07 → "+2.1R", −1 → "−1R". */
function formatRWithSign(value: number): string {
  const rounded = Number(value.toFixed(1));
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${trimTrailingZeros(rounded, 1)}R`;
}
