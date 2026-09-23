/**
 * Оценка звёздами 0–5 (тип ответа stars_0_5). Свои SVG вместо эмодзи — как у остальных
 * значков приложения; заполненные — акцентным цветом темы.
 */
function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" className={filled ? "text-accent" : "text-line"}>
      <path
        d="M12 3.6l2.47 5.02 5.53.8-4 3.9.94 5.5L12 16.22l-4.94 2.6.94-5.5-4-3.9 5.53-.8L12 3.6Z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Просмотр значения: ★★★☆☆ + цифра. */
export function StarsView({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex gap-0.5">
        {Array.from({ length: 5 }, (_, i) => (
          <StarIcon key={i} filled={i < value} />
        ))}
      </span>
      <span className="text-xs text-muted">{value}/5</span>
    </span>
  );
}

/**
 * Ввод: тап по звезде N ставит N; повторный тап по уже выбранной N сбрасывает в 0 —
 * так достижим и валидный ответ «0 звёзд». Справа — цифра текущего значения («—»,
 * пока не отвечено), чтобы 0 выглядел ответом, а не пустотой.
 */
export function StarsInput({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex">
        {Array.from({ length: 5 }, (_, i) => {
          const score = i + 1;
          return (
            <button
              key={score}
              type="button"
              aria-label={`${score} из 5`}
              onClick={() => onChange(value === score ? 0 : score)}
              className="-my-1 px-1 py-1 first:pl-0"
            >
              <StarIcon filled={value !== undefined && score <= value} />
            </button>
          );
        })}
      </div>
      <span className="text-xs tabular-nums text-muted">{value === undefined ? "—" : `${value}/5`}</span>
    </div>
  );
}
