import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../../api/http";
import {
  createCategory,
  createItem,
  deleteCategory,
  deleteItem,
  getCategories,
  renameCategory,
  renameItem,
  reorderItems,
} from "../api";
import { plural } from "../plural";
import type { AnswerType, ConstructorCategory } from "../types";

const TYPE_LABELS: Record<AnswerType, string> = {
  yes_no: "Да/Нет",
  scale_0_10: "0–10",
  stars_0_5: "Звёзды",
  choice: "Варианты",
  text: "Текст",
};

/**
 * Конструктор категорий и чек-листов. Правила сохранности данных (дублируются сервером):
 * тип ответа задаётся при создании пункта и не меняется; удаление пункта/категории, по
 * которым уже есть данные, — это архив (ответы и разборы сохраняются).
 */
export function JournalSettings() {
  const [categories, setCategories] = useState<ConstructorCategory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newCategoryName, setNewCategoryName] = useState("");

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    try {
      const response = await getCategories();
      setCategories(response.categories);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить настройки");
    } finally {
      setIsLoading(false);
    }
  }

  /** true — действие прошло; поля ввода очищаются только при успехе, чтобы при ошибке
      («категория уже есть») набранный текст не пропадал. */
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      await refresh();
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить изменение");
      return false;
    }
  }

  return (
    <section className="flex flex-1 flex-col gap-4 pt-10 pb-4">
      <Link to="/analysis" className="flex items-center gap-1 px-4 text-sm text-accent">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M14.5 5 8 12l6.5 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Анализ
      </Link>
      <h1 className="px-4 text-lg font-medium text-ink">Категории и чек-листы</h1>

      {error && <p className="px-4 text-xs text-negative">{error}</p>}
      {isLoading && <p className="px-6 text-center text-sm text-muted">Загрузка…</p>}

      {!isLoading &&
        categories.map((category) => (
          <CategoryCard
            key={category.id}
            category={category}
            onRename={(name) => run(() => renameCategory(category.id, name))}
            onDelete={() => {
              const message =
                category.entriesCount > 0
                  ? `У категории «${category.name}» ${category.entriesCount} разборов — она уйдёт в архив, разборы сохранятся. Продолжить?`
                  : `Удалить категорию «${category.name}»?`;
              if (window.confirm(message)) run(() => deleteCategory(category.id));
            }}
            onAddItem={(label, answerType, options) => run(() => createItem(category.id, label, answerType, options))}
            onReorderItems={(itemIds) => run(() => reorderItems(category.id, itemIds))}

            onRenameItem={(itemId, label) => run(() => renameItem(itemId, label))}
            onDeleteItem={(itemId, hasAnswers, label) => {
              const message = hasAnswers
                ? `По пункту «${label}» уже есть ответы — он уйдёт в архив, ответы сохранятся. Продолжить?`
                : `Удалить пункт «${label}»?`;
              if (window.confirm(message)) run(() => deleteItem(itemId));
            }}
          />
        ))}

      {/* Новая категория */}
      <form
        className="mx-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const name = newCategoryName.trim();
          if (!name) return;
          void run(() => createCategory(name)).then((ok) => {
            if (ok) setNewCategoryName("");
          });
        }}
      >
        <input
          value={newCategoryName}
          onChange={(event) => setNewCategoryName(event.target.value)}
          placeholder="Новая категория…"
          className="min-w-0 flex-1 rounded-xl border border-line bg-card px-3 py-2.5 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={newCategoryName.trim().length === 0}
          className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
        >
          Создать
        </button>
      </form>
    </section>
  );
}

function CategoryCard({
  category,
  onRename,
  onDelete,
  onAddItem,
  onRenameItem,
  onDeleteItem,
  onReorderItems,
}: {
  category: ConstructorCategory;
  onRename: (name: string) => void;
  onDelete: () => void;
  onAddItem: (label: string, answerType: AnswerType, options?: string[]) => Promise<boolean>;
  onRenameItem: (itemId: number, label: string) => void;
  onDeleteItem: (itemId: number, hasAnswers: boolean, label: string) => void;
  onReorderItems: (itemIds: number[]) => Promise<boolean>;
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [name, setName] = useState(category.name);
  const [newItemLabel, setNewItemLabel] = useState("");
  const [newItemType, setNewItemType] = useState<AnswerType>("yes_no");
  /** Для типа «Варианты»: список через запятую, парсит и валидирует сервер. */
  const [newItemOptions, setNewItemOptions] = useState("");

  /**
   * Drag-and-drop порядка пунктов (23.09.2026) — на pointer events, без библиотек:
   * работает и мышью, и пальцем в PWA. Захват — только за ручку-грип (у неё touch-none,
   * чтобы страница не скроллилась). Пока строку тянут, локальный порядок переставляется
   * на каждом пересечении границы строки; отпустили — порядок уходит на сервер, при
   * ошибке refresh вернёт серверный.
   */
  const [localItems, setLocalItemsState] = useState(category.items);
  const localItemsRef = useRef(category.items);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const dragState = useRef<{ pointerId: number; startIndex: number; currentIndex: number; startY: number; rowH: number } | null>(null);

  useEffect(() => {
    localItemsRef.current = category.items;
    setLocalItemsState(category.items);
  }, [category.items]);

  function setLocalItems(next: typeof category.items) {
    localItemsRef.current = next;
    setLocalItemsState(next);
  }

  function handleDragStart(event: ReactPointerEvent, index: number) {
    if (!event.isPrimary) return;
    const row = (event.currentTarget as HTMLElement).closest("[data-item-row]");
    const rowH = row instanceof HTMLElement ? row.offsetHeight : 40;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragState.current = { pointerId: event.pointerId, startIndex: index, currentIndex: index, startY: event.clientY, rowH };
    setDragIndex(index);
    event.preventDefault();
  }

  function handleDragMove(event: ReactPointerEvent) {
    const st = dragState.current;
    if (!st || event.pointerId !== st.pointerId) return;
    const shift = Math.round((event.clientY - st.startY) / st.rowH);
    const target = Math.min(Math.max(st.startIndex + shift, 0), localItemsRef.current.length - 1);
    if (target === st.currentIndex) return;
    const next = [...localItemsRef.current];
    const [moved] = next.splice(st.currentIndex, 1);
    if (!moved) return;
    next.splice(target, 0, moved);
    st.currentIndex = target;
    setLocalItems(next);
    setDragIndex(target);
  }

  function handleDragEnd(event: ReactPointerEvent) {
    const st = dragState.current;
    if (!st || event.pointerId !== st.pointerId) return;
    dragState.current = null;
    setDragIndex(null);
    const ids = localItemsRef.current.map((item) => item.id);
    const original = category.items.map((item) => item.id);
    if (ids.some((id, index) => id !== original[index])) {
      void onReorderItems(ids);
    }
  }

  return (
    <div className="mx-4 flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        {isRenaming ? (
          <form
            className="flex min-w-0 flex-1 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = name.trim();
              if (trimmed && trimmed !== category.name) onRename(trimmed);
              setIsRenaming(false);
            }}
          >
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              className="min-w-0 flex-1 rounded-xl border border-line bg-card px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
            />
            <button type="submit" className="text-sm font-medium text-accent">
              Ок
            </button>
          </form>
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-1">
              <span className="truncate text-sm font-medium text-ink">{category.name}</span>
              <button
                type="button"
                onClick={() => setIsRenaming(true)}
                aria-label="Переименовать"
                className="-my-2 p-2 text-muted"
              >
                <PencilIcon />
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <span className="text-xs text-muted">{plural(category.entriesCount, "разбор", "разбора", "разборов")}</span>
              <button type="button" onClick={onDelete} aria-label="Удалить категорию" className="-my-2 p-2 text-negative">
                <CrossIcon />
              </button>
            </div>
          </>
        )}
      </div>

      {localItems.length > 0 && (
        <div className="divide-y divide-line/70">
          {localItems.map((item, index) => (
            <ItemRow
              key={item.id}
              label={item.label}
              answerType={item.answerType}
              isDragging={dragIndex === index}
              handle={
                <span
                  role="button"
                  aria-label="Перетащить пункт"
                  className="-my-2 shrink-0 cursor-grab touch-none p-2 pl-0 text-muted active:cursor-grabbing"
                  onPointerDown={(event) => handleDragStart(event, index)}
                  onPointerMove={handleDragMove}
                  onPointerUp={handleDragEnd}
                  onPointerCancel={handleDragEnd}
                >
                  <GripIcon />
                </span>
              }
              onRename={(label) => onRenameItem(item.id, label)}
              onDelete={() => onDeleteItem(item.id, item.hasAnswers, item.label)}
            />
          ))}
        </div>
      )}

      {/* Новый пункт: текст + тип ответа. Тип фиксируется при создании — сменить нельзя. */}
      <form
        className="flex flex-col gap-2 rounded-xl border border-dashed border-line p-3"
        onSubmit={(event) => {
          event.preventDefault();
          const label = newItemLabel.trim();
          if (!label) return;
          const options =
            newItemType === "choice"
              ? newItemOptions.split(",").map((part) => part.trim()).filter(Boolean)
              : undefined;
          void onAddItem(label, newItemType, options).then((ok) => {
            if (ok) {
              setNewItemLabel("");
              setNewItemOptions("");
            }
          });
        }}
      >
        <input
          value={newItemLabel}
          onChange={(event) => setNewItemLabel(event.target.value)}
          placeholder="Новый пункт чек-листа…"
          className="w-full rounded-xl border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
        />
        {newItemType === "choice" && (
          <input
            value={newItemOptions}
            onChange={(event) => setNewItemOptions(event.target.value)}
            placeholder="Варианты через запятую: Пробой, Отбой, Ретест"
            className="w-full rounded-xl border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
          />
        )}
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {(Object.keys(TYPE_LABELS) as AnswerType[]).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setNewItemType(type)}
                className={`rounded-full px-3 py-1 text-xs ${
                  newItemType === type ? "bg-accent font-medium text-white" : "border border-line text-muted"
                }`}
              >
                {TYPE_LABELS[type]}
              </button>
            ))}
          </div>
          <button
            type="submit"
            disabled={newItemLabel.trim().length === 0}
            className="shrink-0 text-sm font-medium text-accent disabled:opacity-40"
          >
            Добавить
          </button>
        </div>
      </form>
    </div>
  );
}

function ItemRow({
  label,
  answerType,
  handle,
  isDragging,
  onRename,
  onDelete,
}: {
  label: string;
  answerType: AnswerType;
  handle: React.ReactNode;
  isDragging: boolean;
  onRename: (label: string) => void;
  onDelete: () => void;
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [draft, setDraft] = useState(label);

  if (isRenaming) {
    return (
      <form
        data-item-row
        className="flex gap-2 py-2 first:pt-0 last:pb-0"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = draft.trim();
          if (trimmed && trimmed !== label) onRename(trimmed);
          setIsRenaming(false);
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          autoFocus
          className="min-w-0 flex-1 rounded-xl border border-line bg-card px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
        />
        <button type="submit" className="text-sm font-medium text-accent">
          Ок
        </button>
      </form>
    );
  }

  return (
    <div
      data-item-row
      className={`flex items-center justify-between gap-2 py-2 first:pt-0 last:pb-0 ${
        isDragging ? "relative z-10 rounded-lg bg-accent/5" : ""
      }`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {handle}
        <span className="truncate text-sm text-ink">{label}</span>
        <span className="shrink-0 rounded-full bg-line/60 px-2 py-0.5 text-[11px] text-muted">
          {TYPE_LABELS[answerType]}
        </span>
      </div>
      {/* -m/p: иконки 14px, но зона нажатия ~34px — пальцем попадать проще (touch target). */}
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          onClick={() => setIsRenaming(true)}
          aria-label="Переименовать пункт"
          className="-my-2 p-2.5 text-muted"
        >
          <PencilIcon />
        </button>
        <button type="button" onClick={onDelete} aria-label="Удалить пункт" className="-my-2 p-2.5 text-negative">
          <CrossIcon />
        </button>
      </div>
    </div>
  );
}

/** Ручка перетаскивания: шесть точек, как принято у драг-хэндлов. */
function GripIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="9" cy="5.5" r="1.7" />
      <circle cx="15" cy="5.5" r="1.7" />
      <circle cx="9" cy="12" r="1.7" />
      <circle cx="15" cy="12" r="1.7" />
      <circle cx="9" cy="18.5" r="1.7" />
      <circle cx="15" cy="18.5" r="1.7" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 20h4l11-11a2.1 2.1 0 0 0-4-4L4 16v4Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
