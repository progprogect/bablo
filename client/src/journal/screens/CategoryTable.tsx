import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../../api/http";
import { formatSignedR } from "../../lib/format";
import { getAnalysis } from "../api";
import type {
  AnalysisColumn,
  AnalysisResponse,
  AnalysisRow,
  AnswerValue,
  ColumnAggregate,
} from "../types";

/**
 * Таблица категории: строки — разобранные сделки, колонки — пункты чек-листа + факт R.
 * Сортировка — тапом по любому заголовку (desc → asc → сброс); под заголовками — строка
 * фильтров по каждому полю (23.09.2026): актив, знак R, Да/Нет, «≥ N» для шкал и звёзд,
 * вариант для «выбора», «содержит» для текста. Агрегаты «В плюсе / В минусе» считаются
 * по ОТФИЛЬТРОВАННЫМ строкам — сервер отдаёт агрегаты всей категории, но при активных
 * фильтрах честные цифры только по видимому набору.
 */

type SortKey = { kind: "trade" } | { kind: "r" } | { kind: "item"; itemId: number };

/** Значение фильтра колонки; пустая строка = фильтра нет. Ключи: "trade" | "r" | "i<id>". */
type Filters = Record<string, string>;

export function CategoryTable() {
  const { id } = useParams();
  const categoryId = Number(id);
  const [data, setData] = useState<AnalysisResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean } | null>(null);
  const [filters, setFilters] = useState<Filters>({});

  useEffect(() => {
    getAnalysis(categoryId)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить таблицу"));
  }, [categoryId]);

  const symbols = useMemo(() => {
    const set = new Set<string>();
    for (const row of data?.rows ?? []) set.add(row.symbol.replace(/-USDT$/, ""));
    return [...set].sort();
  }, [data]);

  const filteredRows = useMemo(() => {
    if (!data) return [];
    return data.rows.filter((row) => rowPassesFilters(row, data.columns, filters));
  }, [data, filters]);

  const rows = useMemo(() => {
    if (!sort) return filteredRows;
    const sorted = [...filteredRows].sort((a, b) => compareRows(a, b, sort.key, data?.columns ?? []));
    return sort.desc ? sorted.reverse() : sorted;
  }, [filteredRows, sort, data]);

  /** Агрегаты по отфильтрованным строкам — считаем на клиенте. */
  const aggregates = useMemo(() => {
    const columns = data?.columns ?? [];
    return {
      plus: aggregateGroup(columns, filteredRows.filter((row) => (row.statsResultR ?? 0) > 0)),
      minus: aggregateGroup(columns, filteredRows.filter((row) => (row.statsResultR ?? 0) < 0)),
    };
  }, [data, filteredRows]);

  const hasFilters = Object.values(filters).some((value) => value !== "");

  function toggleSort(key: SortKey) {
    setSort((current) => {
      if (current && sameKey(current.key, key)) {
        return current.desc ? { key, desc: false } : null; // desc → asc → сброс
      }
      return { key, desc: true };
    });
  }

  function setFilter(key: string, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
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
      <div className="flex items-baseline justify-between px-4">
        <h1 className="text-lg font-medium text-ink">
          {data.category.name}
          {data.category.archived ? <span className="text-muted"> (архив)</span> : null}
        </h1>
        {hasFilters && (
          <button type="button" onClick={() => setFilters({})} className="text-xs font-medium text-accent">
            Сбросить фильтры · {rows.length}
          </button>
        )}
      </div>

      {data.rows.length === 0 ? (
        <p className="px-6 py-6 text-center text-sm text-muted">
          В этой категории пока нет разобранных сделок.
        </p>
      ) : (
        <div className="overflow-x-auto pb-2 [-webkit-overflow-scrolling:touch]">
          <table className="mx-4 border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <SortableTh
                  label="Сделка"
                  sticky
                  roundedLeft
                  active={sort !== null && sort.key.kind === "trade"}
                  desc={sort?.desc ?? false}
                  onClick={() => toggleSort({ kind: "trade" })}
                />
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
                    onClick={() => toggleSort({ kind: "item", itemId: column.itemId })}
                    roundedRight={index === data.columns.length - 1}
                  />
                ))}
              </tr>

              {/* Строка фильтров: по каждому полю свой компактный контрол. */}
              <tr>
                <th className="sticky left-0 z-10 border-b border-l border-line bg-card px-2 py-1">
                  <FilterSelect
                    value={filters["trade"] ?? ""}
                    onChange={(value) => setFilter("trade", value)}
                    options={[["", "Все"], ...symbols.map((symbol) => [symbol, symbol] as [string, string])]}
                  />
                </th>
                <th className="border-b border-line bg-card px-2 py-1">
                  <FilterSelect
                    value={filters["r"] ?? ""}
                    onChange={(value) => setFilter("r", value)}
                    options={[
                      ["", "Все"],
                      ["plus", "Плюс"],
                      ["minus", "Минус"],
                      ["zero", "0"],
                    ]}
                  />
                </th>
                {data.columns.map((column) => (
                  <th key={column.itemId} className="border-b border-r border-line bg-card px-2 py-1">
                    <ColumnFilter
                      column={column}
                      value={filters[`i${column.itemId}`] ?? ""}
                      onChange={(value) => setFilter(`i${column.itemId}`, value)}
                    />
                  </th>
                ))}
              </tr>

              <AggregateRow label="В плюсе" tone="positive" group={aggregates.plus} columns={data.columns} />
              <AggregateRow label="В минусе" tone="negative" group={aggregates.minus} columns={data.columns} />
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
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={2 + data.columns.length}
                    className="border-b border-l border-r border-line bg-card px-3 py-6 text-center text-muted"
                  >
                    Под фильтры не попала ни одна сделка.
                  </td>
                </tr>
              )}
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
  sticky = false,
  roundedLeft = false,
  roundedRight = false,
}: {
  label: string;
  active: boolean;
  desc: boolean;
  onClick: () => void;
  sticky?: boolean;
  roundedLeft?: boolean;
  roundedRight?: boolean;
}) {
  return (
    <th
      onClick={onClick}
      className={`whitespace-nowrap border-b border-r border-t border-line bg-card px-3 py-2 font-medium ${
        sticky ? "sticky left-0 z-10 border-l text-left" : "text-center"
      } ${roundedLeft ? "rounded-tl-xl" : ""} ${roundedRight ? "rounded-tr-xl" : ""} cursor-pointer select-none ${
        active ? "text-accent" : "text-muted"
      }`}
    >
      {label}
      {active ? (desc ? " ↓" : " ↑") : ""}
    </th>
  );
}

/** Нативный select — лучший компактный контрол фильтра на телефоне. */
function FilterSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={`h-6 w-full min-w-[3.5rem] appearance-none rounded-md border bg-card px-1.5 text-[10px] ${
        value !== "" ? "border-accent text-accent" : "border-line text-muted"
      }`}
    >
      {options.map(([optionValue, optionLabel]) => (
        <option key={optionValue} value={optionValue}>
          {optionLabel}
        </option>
      ))}
    </select>
  );
}

/** Фильтр колонки-пункта по типу ответа. */
function ColumnFilter({
  column,
  value,
  onChange,
}: {
  column: AnalysisColumn;
  value: string;
  onChange: (value: string) => void;
}) {
  if (column.answerType === "yes_no") {
    return (
      <FilterSelect
        value={value}
        onChange={onChange}
        options={[
          ["", "Все"],
          ["yes", "Да"],
          ["no", "Нет"],
        ]}
      />
    );
  }
  if (column.answerType === "scale_0_10" || column.answerType === "stars_0_5") {
    const max = column.answerType === "stars_0_5" ? 5 : 10;
    const thresholds: [string, string][] = [["", "Все"]];
    for (let n = 1; n <= max; n += 1) thresholds.push([String(n), `≥ ${n}`]);
    return <FilterSelect value={value} onChange={onChange} options={thresholds} />;
  }
  if (column.answerType === "choice") {
    return (
      <FilterSelect
        value={value}
        onChange={onChange}
        options={[["", "Все"], ...(column.options ?? []).map((option) => [option, option] as [string, string])]}
      />
    );
  }
  // text: подстрока
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder="содержит…"
      className={`h-6 w-full min-w-[6rem] rounded-md border bg-card px-1.5 text-[10px] text-ink placeholder:text-muted focus:outline-none ${
        value !== "" ? "border-accent" : "border-line"
      }`}
    />
  );
}

function rowPassesFilters(row: AnalysisRow, columns: AnalysisColumn[], filters: Filters): boolean {
  const symbolFilter = filters["trade"] ?? "";
  if (symbolFilter !== "" && row.symbol.replace(/-USDT$/, "") !== symbolFilter) return false;

  const rFilter = filters["r"] ?? "";
  if (rFilter !== "") {
    const r = row.statsResultR ?? 0;
    if (rFilter === "plus" && !(r > 0)) return false;
    if (rFilter === "minus" && !(r < 0)) return false;
    if (rFilter === "zero" && r !== 0) return false;
  }

  for (const column of columns) {
    const filter = filters[`i${column.itemId}`] ?? "";
    if (filter === "") continue;
    const value = row.answers[column.itemId];
    switch (column.answerType) {
      case "yes_no":
        if (value !== (filter === "yes")) return false;
        break;
      case "scale_0_10":
      case "stars_0_5":
        if (typeof value !== "number" || value < Number(filter)) return false;
        break;
      case "choice":
        if (value !== filter) return false;
        break;
      case "text":
        if (typeof value !== "string" || !value.toLowerCase().includes(filter.toLowerCase())) return false;
        break;
    }
  }
  return true;
}

/** Агрегаты группы по видимым строкам — зеркало серверной buildAnalysisAggregates. */
function aggregateGroup(columns: AnalysisColumn[], rows: AnalysisRow[]) {
  const byItem: Record<number, ColumnAggregate> = {};
  for (const column of columns) {
    switch (column.answerType) {
      case "yes_no": {
        let yesCount = 0;
        let total = 0;
        for (const row of rows) {
          const value = row.answers[column.itemId];
          if (typeof value === "boolean") {
            total += 1;
            if (value) yesCount += 1;
          }
        }
        byItem[column.itemId] = { kind: "yes_no", yesCount, total };
        break;
      }
      case "scale_0_10":
      case "stars_0_5": {
        let sum = 0;
        let total = 0;
        for (const row of rows) {
          const value = row.answers[column.itemId];
          if (typeof value === "number") {
            total += 1;
            sum += value;
          }
        }
        byItem[column.itemId] = { kind: "scale", average: total > 0 ? sum / total : null, total };
        break;
      }
      case "choice": {
        const counts = new Map<string, number>();
        let total = 0;
        for (const row of rows) {
          const value = row.answers[column.itemId];
          if (typeof value === "string") {
            total += 1;
            counts.set(value, (counts.get(value) ?? 0) + 1);
          }
        }
        let top: { value: string; count: number } | null = null;
        for (const [optionValue, count] of counts) {
          if (top === null || count > top.count) top = { value: optionValue, count };
        }
        byItem[column.itemId] = { kind: "choice", top, total };
        break;
      }
      default: {
        let total = 0;
        for (const row of rows) {
          if (typeof row.answers[column.itemId] === "string") total += 1;
        }
        byItem[column.itemId] = { kind: "text", total };
      }
    }
  }
  return { tradesCount: rows.length, byItem };
}

/** Строка агрегатов группы: доля «да» / среднее / топ-вариант / число текстов. */
function AggregateRow({
  label,
  tone,
  group,
  columns,
}: {
  label: string;
  tone: "positive" | "negative";
  group: ReturnType<typeof aggregateGroup>;
  columns: AnalysisColumn[];
}) {
  const toneClass = tone === "positive" ? "text-positive" : "text-negative";
  const bgClass = tone === "positive" ? "bg-positive/5" : "bg-negative/5";
  return (
    <tr>
      {/* Sticky-ячейке нужен НЕпрозрачный фон: полупрозрачная тонировка поверх card
          просвечивала бы проезжающие под ней колонки при горизонтальном скролле. */}
      <th
        className={`sticky left-0 z-10 whitespace-nowrap border-b border-l border-line bg-card px-3 py-1.5 text-left font-medium ${toneClass}`}
      >
        {label} · {group.tradesCount}
      </th>
      <th className={`border-b border-line ${bgClass} px-3 py-1.5`} />
      {columns.map((column) => (
        <th
          key={column.itemId}
          className={`whitespace-nowrap border-b border-r border-line ${bgClass} px-3 py-1.5 text-center font-medium ${toneClass}`}
        >
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
  if (aggregate.kind === "choice") {
    return aggregate.top === null
      ? "—"
      : `${Math.round((aggregate.top.count / aggregate.total) * 100)}% ${aggregate.top.value}`;
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
  if (answerType === "choice") {
    return <span className="whitespace-nowrap text-ink">{String(value)}</span>;
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
  if (a.kind === "item") return b.kind === "item" && b.itemId === a.itemId;
  return a.kind === b.kind;
}

function compareRows(a: AnalysisRow, b: AnalysisRow, key: SortKey, columns: AnalysisColumn[]): number {
  if (key.kind === "trade") {
    return (a.closedAt ?? "").localeCompare(b.closedAt ?? "");
  }
  if (key.kind === "r") {
    return (a.statsResultR ?? Number.NEGATIVE_INFINITY) - (b.statsResultR ?? Number.NEGATIVE_INFINITY);
  }
  const column = columns.find((candidate) => candidate.itemId === key.itemId);
  const left = a.answers[key.itemId];
  const right = b.answers[key.itemId];
  // Строковые типы (варианты, текст) сортируются по алфавиту, пустые — всегда в конце.
  if (column && (column.answerType === "choice" || column.answerType === "text")) {
    const leftStr = typeof left === "string" ? left : null;
    const rightStr = typeof right === "string" ? right : null;
    if (leftStr === null && rightStr === null) return 0;
    if (leftStr === null) return -1;
    if (rightStr === null) return 1;
    return leftStr.localeCompare(rightStr, "ru");
  }
  return answerRank(left) - answerRank(right);
}

/** Порядок для сортировки чисел/да-нет: нет ответа < «нет» < «да»; шкала — по числу. */
function answerRank(value: AnswerValue | undefined): number {
  if (value === undefined) return Number.NEGATIVE_INFINITY;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  return 0;
}
