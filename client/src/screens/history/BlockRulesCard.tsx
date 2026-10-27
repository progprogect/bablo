import { BlockedMark } from "../../components/BlockedMark";

/**
 * Шпаргалка «когда блокируется торговля» («История» → «Настройки», запрос
 * пользователя от 02.10.2026). Правил стало много (docs/RISK_ENGINE.md), и держать их в
 * голове перед входом — лишняя работа: карточка показывает расклады дня так же, как
 * гистограмма часов показывает закрытые часы, — тем же замком.
 *
 * Это справка, а не состояние: ничего не грузит с сервера и ничем не управляет. Поэтому
 * тексты статичные — при изменении правил их надо править здесь вместе с risk/limits.ts.
 */

type Outcome = "tp" | "sl";

type Scenario = {
  /** Последовательность закрытых сделок дня — слева направо по времени. */
  chips: { outcome: Outcome; label: string }[];
  /** Что это значит: короткая причина, без «торговля возобновится» — таймер и так на дашборде. */
  note: string;
  /** Закрывает ли расклад кнопку. */
  blocked: boolean;
};

/**
 * Расклады одного торгового дня (правила #4, #15). Строки про тейки убраны 25.10.2026
 * вместе с самими правилами (#3 +3R, #5 два тейка, #6 тейк ≥ 2R): пока идут тейки,
 * торговать можно дальше — день заканчивает стоп. В ПН и ПТ строка про один стоп не
 * действует, там день закрывает первый же результат, см. WEEKDAY_SCENARIOS.
 */
const DAY_SCENARIOS: Scenario[] = [
  {
    chips: [{ outcome: "sl", label: "Стоп" }],
    note: "час паузы, торгуем дальше (кроме ПН и ПТН)",
    blocked: false,
  },
  {
    // Размер тейка здесь не важен: стоп после любого тейка закрывает день (правило #15).
    chips: [
      { outcome: "tp", label: "Тейк" },
      { outcome: "sl", label: "Стоп" },
    ],
    note: "стоп торговля",
    blocked: true,
  },
  {
    chips: [
      { outcome: "sl", label: "Стоп" },
      { outcome: "tp", label: "Тейк" },
    ],
    note: "стоп торговля",
    blocked: true,
  },
];

/**
 * Правило #16 (10.10.2026, тейк добавлен 25.10.2026): в понедельник и пятницу день
 * закрывает ЛЮБОЙ первый результат — и стоп, и тейк. Края недели худшее время настаивать:
 * отыгрываться после стопа нечем, а прибыль забирается сразу.
 *
 * Строки — по триггеру, а не по дню недели (правка 10.10.2026): слева триггер, справа
 * результат, как во всех остальных раскладах; какие именно это дни, говорит заголовок
 * блока, и одинаковые строки на ПН и на ПТ читались бы как ошибка вёрстки.
 */
const WEEKDAY_SCENARIOS: Scenario[] = [
  { chips: [{ outcome: "tp", label: "Тейк" }], note: "стоп торговля", blocked: true },
  { chips: [{ outcome: "sl", label: "Стоп" }], note: "стоп торговля", blocked: true },
];

/**
 * Лестница пауз после стопов (правило #14): внутри серии день закрывает уже один стоп, и
 * к нему добавляется выходной. Выходной ровно один и не растёт (правка 27.10.2026) —
 * поэтому третья строка повторяет вторую: так видно, что дальше ничего не копится.
 */
const CHAIN_SCENARIOS: Scenario[] = [
  {
    chips: [
      { outcome: "sl", label: "Стоп" },
      { outcome: "sl", label: "Стоп" },
    ],
    note: "день закрыт, серия началась",
    blocked: true,
  },
  { chips: [{ outcome: "sl", label: "Стоп" }], note: "день закрыт, завтра выходной", blocked: true },
  { chips: [{ outcome: "sl", label: "Стоп" }], note: "день закрыт, снова один выходной", blocked: true },
];

function OutcomeChip({ outcome, label }: { outcome: Outcome; label: string }) {
  return (
    <span
      className={
        outcome === "tp"
          ? "rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-600"
          : "rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600"
      }
    >
      {label}
    </span>
  );
}

function ScenarioRow({ scenario }: { scenario: Scenario }) {
  return (
    <li className="flex items-center gap-2 py-1">
      <span className="flex shrink-0 items-center gap-1">
        {scenario.chips.map((chip, index) => (
          <OutcomeChip key={index} outcome={chip.outcome} label={chip.label} />
        ))}
      </span>
      <span className="flex-1 text-right text-[11px] text-slate-500">{scenario.note}</span>
      <span className="w-3.5 shrink-0">{scenario.blocked ? <BlockedMark /> : null}</span>
    </li>
  );
}

export function BlockRulesCard() {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div>
        <h2 className="text-sm font-medium text-ink">Когда блокируется торговля</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Замок — сделку сегодня уже не открыть. Безубытки и ручные закрытия в счёт не идут.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs text-slate-500">За день</p>
        <ul className="flex flex-col">
          {DAY_SCENARIOS.map((scenario, index) => (
            <ScenarioRow key={index} scenario={scenario} />
          ))}
        </ul>
        <p className="text-[11px] text-slate-400">
          Тейки день не закрывают — пока идут тейки, торгуем дальше.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs text-slate-500">Понедельник и пятница</p>
        <ul className="flex flex-col">
          {WEEKDAY_SCENARIOS.map((scenario, index) => (
            <ScenarioRow key={index} scenario={scenario} />
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs text-slate-500">Серия стопов</p>
        <ul className="flex flex-col">
          {CHAIN_SCENARIOS.map((scenario, index) => (
            <ScenarioRow key={index} scenario={scenario} />
          ))}
        </ul>
        <p className="text-[11px] text-slate-400">
          Любой тейк обнуляет серию — два стопа запускают серию.
        </p>
      </div>
    </section>
  );
}
