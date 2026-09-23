import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../../api/http";
import { formatSignedR } from "../../lib/format";
import { getAnalysis } from "../api";
import type { AnalysisResponse, AnalysisRow, AnswerValue, ColumnAggregate } from "../types";

type SortKey = { kind: "r" } | { kind: "item"; itemId: number };

/**
 * Таблица категории: строки — разобранные сделки, колонки — пункты чек-листа + факт R.
 * Сверху — агрегаты «В плюсе / В минусе»: доля «да» и среднее по шкале отдельно у
 * прибыльных и убыточных сделок, чтобы было видно, какие пункты «сильные», а какие
 * проседают. На телефоне колонка сделки закреплена, остальное скроллится горизонтально.
 */
export function CategoryTable() {
  const { id } = useParams();
  const categoryId = Number(id);
  const [data, setData] = useState<AnalysisResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean } | null>(null);

  useEffect(() => {
    getAnalysis(categoryId)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить таблицу"));
  }, [categoryId]);

  const rows = useMemo(() => {
    if (!data) return [];
    if (!sort) return data.rows;
    const sorted = [...data.rows].sort((a, b) => compareRows(a, b, sort.key));
    return sort.desc ? sorted.reverse() : sorted;
  }, [data, sort]);

  function toggleSort(key: SortKey) {
    setSort((current) => {
      if (current && sameKey(current.key, key)) {
        return current.desc ? { key, desc: false } : null; // desc → asc → сброс
      }
      return { key, desc: true };
    });
  }

  if (error) {
    return (
      <section className="flex flex-1 flex-col gap-4 pt-10">
        <BackLink />
        <p className="px-6 text-center text-sm text-negative">{error}</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="flex flex-1 items-center justify-center px-6 text-sm text-muted">
        Загрузка…
      </section>
    );
  }

  return (
    <section className="flex flex-1 flex-col gap-4 pt-10 pb-4">
      <BackLink />
      <h1 className="px-4 text-lg font-medium text-ink">
        {data.category.name}
        {data.category.archived ? <span className="text-muted"> (архив)</span> : null}
      </h1>

      {data.rows.length === 0 ? (
        <p className="px-6 py-6 text-center text-sm text-muted">
          В этой категории пока нет разобранных сделок.
        </p>
      ) : (
        <div className="overflow-x-auto pb-2 [-webkit-overflow-scrolling:touch]">
          <table className="mx-4 border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 rounded-tl-xl border border-line bg-card px-3 py-2 text-left font-medium text-muted">
                  Сделка
                </th>
                <SortableTh
                  label="R"
                  active={sort !== null && sort.key.kind === "r"}
                  desc={sort?.desc ?? false}
                  onClick={() => toggleSort({ kind: "r" })}
                />
                {data.columns.map((column, index) => (
                  <SortableTh
                    key={column.itemId}
                    label={column.label + (column.archived ? " (архив)" : "")}
                    active={sort !== null && sort.key.kind === "item" && sort.key.itemId === column.itemId}
                    desc={sort?.desc ?? false}
                    onClick={column.answerType === "text" ? undefined : () => toggleSort({ kind: "item", itemId: column.itemId })}
                    roundedRight={index === data.columns.length - 1}
                  />
                ))}
              </tr>
              <AggregateRow label="В плюсе" tone="positive" group={data.aggregates.plus} data={data} />
              <AggregateRow label="В минусе" tone="negative" group={data.aggregates.minus} data={data} />
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.tradeId}>
                  <td className="sticky left-0 z-10 border-b border-l border-line bg-card px-3 py-2">
                    <Link to={`/trades/${row.tradeId}`} className="flex flex-col">
                      <span className="font-medium text-ink">{row.symbol.replace(/-USDT$/, "")}</span>
                      <span className="text-[11px] text-muted">{formatDate(row.closedAt)}</span>
                    </Link>
                  </td>
                  <td className="border-b border-line bg-card px-3 py-2 text-right">
                    <RValue value={row.statsResultR} />
                  </td>
                  {data.columns.map((column) => (
                    <td key={column.itemId} className="border-b border-r border-line bg-card px-3 py-2 text-center">
                      <CellValue value={row.answers[column.itemId]} answerType={column.answerType} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function BackLink() {
  return (
    <Link to="/analysis" className="flex items-center gap-1 px-4 text-sm text-accent">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M14.5 5 8 12l6.5 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Анализ
    </Link>
  );
}

function SortableTh({
  label,
  active,
  desc,
  onClick,
  roundedRight = false,
}: {
  label: string;
  active: boolean;
  desc: boolean;
  onClick?: () => void;
  roundedRight?: boolean;
}) {
  return (
    <th
      onClick={onClick}
      className={`whitespace-nowrap border-b border-r border-t border-line bg-card px-3 py-2 text-center font-medium ${
        roundedRight ? "rounded-tr-xl" : ""
      } ${onClick ? "cursor-pointer select-none" : ""} ${active ? "text-accent" : "text-muted"}`}
    >
      {label}
      {active ? (desc ? " ↓" : " ↑") : ""}
    </th>
  );
}

/** Строка агрегатов группы: доля «да» / среднее по шкале / число текстов. */
function AggregateRow({
  label,
  tone,
  group,
  data,
}: {
  label: string;
  tone: "positive" | "negative";
  group: AnalysisResponse["aggregates"]["plus"];
  data: AnalysisResponse;
}) {
  const toneClass = tone === "positive" ? "text-positive" : "text-negative";
  const bgClass = tone === "positive" ? "bg-positive/5" : "bg-negative/5";
  return (
    <tr>
      <th className={`sticky left-0 z-10 whitespace-nowrap border-b border-l border-line ${bgClass} bg-card px-3 py-1.5 text-left font-medium ${toneClass}`}>
        {label} · {group.tradesCount}
      </th>
      <th className={`border-b border-line ${bgClass} px-3 py-1.5`} />
      {data.columns.map((column) => (
        <th key={column.itemId} className={`whitespace-nowrap border-b border-r border-line ${bgClass} px-3 py-1.5 text-center font-medium ${toneClass}`}>
          {formatAggregate(group.byItem[column.itemId])}
        </th>
      ))}
    </tr>
  );
}

function formatAggregate(aggregate: ColumnAggregate | undefined): string {
  if (!aggregate || aggregate.total === 0) return "—";
  if (aggregate.kind === "yes_no") {
    return `${Math.round((aggregate.yesCount / aggregate.total) * 100)}% да`;
  }
  if (aggregate.kind === "scale") {
    return aggregate.average === null ? "—" : `ср. ${aggregate.average.toFixed(1).replace(/\.0$/, "")}`;
  }
  return `${aggregate.total} зап.`;
}

function CellValue({ value, answerType }: { value: AnswerValue | undefined; answerType: string }) {
  if (value === undefined) return <span className="text-muted">—</span>;
  if (answerType === "yes_no") {
    return value === true ? (
      <span className="font-medium text-positive">✓</span>
    ) : (
      <span className="font-medium text-negative">✕</span>
    );
  }
  if (answerType === "scale_0_10" || answerType === "stars_0_5") {
    return <span className="text-ink tabular-nums">{String(value)}</span>;
  }
  return (
    <span className="inline-block max-w-[9rem] truncate align-bottom text-left text-ink" title={String(value)}>
      {String(value)}
    </span>
  );
}

function RValue({ value }: { value: number | null }) {
  if (value === null || value === 0) return <span className="text-muted">0R</span>;
  return (
    <span className={`font-medium ${value > 0 ? "text-positive" : "text-negative"}`}>
      {formatSignedR(value)}
    </span>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function sameKey(a: SortKey, b: SortKey): boolean {
  return a.kind === "r" ? b.kind === "r" : b.kind === "item" && b.itemId === a.itemId;
}

function compareRows(a: AnalysisRow, b: AnalysisRow, key: SortKey): number {
  if (key.kind === "r") {
    return (a.statsResultR ?? Number.NEGATIVE_INFINITY) - (b.statsResultR ?? Number.NEGATIVE_INFINITY);
  }
  return answerRank(a.answers[key.itemId]) - answerRank(b.answers[key.itemId]);
}

/** Порядок для сортировки: нет ответа < «нет» < «да»; шкала — по числу. */
function answerRank(value: AnswerValue | undefined): number {
  if (value === undefined) return Number.NEGATIVE_INFINITY;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  return 0;
}
