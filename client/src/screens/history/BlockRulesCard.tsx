import { BlockedMark } from "../../components/BlockedMark";

/**
 * Шпаргалка «когда закрывается кнопка Открыть сделку» («История» → «Настройки», запрос
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

/** Расклады одного торгового дня (правила #3, #4, #5, #6, #15). */
const DAY_SCENARIOS: Scenario[] = [
  { chips: [{ outcome: "tp", label: "Тейк 1R" }], note: "торгуем дальше", blocked: false },
  { chips: [{ outcome: "tp", label: "Тейк 2R" }], note: "хватит на сегодня", blocked: true },
  { chips: [{ outcome: "tp", label: "Тейк 3R" }], note: "дневная цель", blocked: true },
  {
    chips: [
      { outcome: "tp", label: "Тейк 1R" },
      { outcome: "tp", label: "Тейк" },
    ],
    note: "два тейка за день",
    blocked: true,
  },
  {
    chips: [
      { outcome: "tp", label: "Тейк 1R" },
      { outcome: "sl", label: "Стоп" },
    ],
    note: "и тейк, и стоп",
    blocked: true,
  },
  { chips: [{ outcome: "sl", label: "Стоп" }], note: "час паузы, потом цель до 1/2", blocked: false },
  {
    chips: [
      { outcome: "sl", label: "Стоп" },
      { outcome: "tp", label: "Тейк" },
    ],
    note: "и тейк, и стоп",
    blocked: true,
  },
];

/** Лестница пауз после стопов (правило #14): каждое следующее срабатывание дороже. */
const CHAIN_SCENARIOS: Scenario[] = [
  {
    chips: [
      { outcome: "sl", label: "Стоп" },
      { outcome: "sl", label: "Стоп" },
    ],
    note: "день закрыт, серия началась",
    blocked: true,
  },
  { chips: [{ outcome: "sl", label: "Стоп" }], note: "дальше хватает одного: день и выходной", blocked: true },
  { chips: [{ outcome: "sl", label: "Стоп" }], note: "потом — день и два выходных", blocked: true },
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
        <h2 className="text-sm font-medium text-ink">Когда кнопка закрывается</h2>
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
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs text-slate-500">Серия стопов</p>
        <ul className="flex flex-col">
          {CHAIN_SCENARIOS.map((scenario, index) => (
            <ScenarioRow key={index} scenario={scenario} />
          ))}
        </ul>
        <p className="text-[11px] text-slate-400">
          Любой тейк обнуляет серию — снова хватает двух стопов за день.
        </p>
      </div>
    </section>
  );
}
