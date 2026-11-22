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

/** «day» — не исход сделки, а сам день (выходной, правило #19): нейтральный серый чип. */
type Outcome = "tp" | "sl" | "day";

type Scenario = {
  /** Последовательность закрытых сделок дня — слева направо по времени. */
  chips: { outcome: Outcome; label: string }[];
  /** Что это значит: короткая причина, без «торговля возобновится» — таймер и так на дашборде. */
  note: string;
  /** Закрывает ли расклад кнопку. */
  blocked: boolean;
};

/**
 * Расклады одного торгового дня (правила #4, #15). Тейк день не закрывает (правила #3,
 * #5 и #6 отменены 25.10.2026) — с 06.11.2026 об этом говорит первая строка блока, а не
 * приписка под ним: расклад читается быстрее строкой, как и все остальные. В ПН и СБ
 * строка про один стоп не действует: там день закрывает уже первый стоп, см.
 * WEEKDAY_SCENARIOS и SATURDAY_SCENARIOS; в ВС день закрывает стоп ПЕРВОЙ сделкой
 * (SUNDAY_SCENARIOS); пятница — выходной целиком.
 */
const DAY_SCENARIOS: Scenario[] = [
  {
    // Первой строкой (просьба пользователя от 06.11.2026): раньше про тейки говорила
    // приписка под блоком, но расклад читается быстрее строкой — как и все остальные.
    chips: [{ outcome: "tp", label: "Тейк" }],
    note: "торгуем дальше",
    blocked: false,
  },
  {
    // Правило #22 (18.11.2026, узкий возврат отменённого #6): полный тейк ПЕРВОЙ сделкой
    // закрывает день. Вторая и дальше — обычные тейки, строка выше.
    chips: [{ outcome: "tp", label: "Тейк 2R первым" }],
    note: "стоп торговля",
    blocked: true,
  },
  {
    chips: [{ outcome: "sl", label: "Стоп" }],
    // Исключения — прямо в строке (просьба пользователя от 06.11.2026). Пятницы тут нет
    // потому, что торговли в пятницу нет вовсе: про неё говорит блок «Пятница» ниже.
    note: "час паузы, торгуем дальше (кроме ПН и СБ)",
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
 * Правило #16 (10.10.2026, тейк добавлен 25.10.2026): день закрывает ЛЮБОЙ первый
 * результат — и стоп, и тейк. Начало недели худшее время настаивать: отыгрываться после
 * стопа нечем, а прибыль забирается сразу.
 *
 * С 06.11.2026 в блоке только понедельник: пятница стала выходным (правило #19), и
 * правило #16 для неё недостижимо — см. FRIDAY_SCENARIOS.
 *
 * Строки — по триггеру, а не по дню недели (правка 10.10.2026): слева триггер, справа
 * результат, как во всех остальных раскладах.
 */
const WEEKDAY_SCENARIOS: Scenario[] = [
  { chips: [{ outcome: "tp", label: "Тейк" }], note: "стоп торговля", blocked: true },
  { chips: [{ outcome: "sl", label: "Стоп" }], note: "стоп торговля", blocked: true },
];

/**
 * Правило #19 (запрос пользователя от 06.11.2026): пятница — выходной, торговля закрыта
 * весь день. Чип тут не исход сделки, а сам день: закрывает его не стоп и не тейк, а
 * календарь, поэтому и подпись нейтральная, без красного и зелёного.
 */
const FRIDAY_SCENARIOS: Scenario[] = [
  { chips: [{ outcome: "day", label: "Весь день" }], note: "выходной, сделок нет", blocked: true },
];

/**
 * Правило #17 (запрос пользователя от 06.11.2026): в субботу день закрывает один стоп, а
 * тейки — нет. Строка про тейк здесь не лишняя: прямо над ней такая же строка «Понедельника»
 * стоит с замком, и без явного «торгуем дальше» суббота читалась бы так же.
 */
const SATURDAY_SCENARIOS: Scenario[] = [
  // Тейк первым (просьба пользователя от 06.11.2026): порядок тот же, что в «За день», —
  // сначала что НЕ закрывает день, потом что закрывает.
  { chips: [{ outcome: "tp", label: "Тейк" }], note: "торгуем дальше", blocked: false },
  { chips: [{ outcome: "sl", label: "Стоп" }], note: "стоп торговля", blocked: true },
];

/**
 * Правило #23 (запрос пользователя от 22.11.2026): первая сделка воскресенья закрыта
 * стопом — день закрыт. Решает только первая сделка — этим воскресенье отличается от
 * субботы, где день закрывает любой стоп. Стоп второй или третьей сделкой живёт по
 * обычным правилам дня (час паузы / тейк+стоп).
 */
const SUNDAY_SCENARIOS: Scenario[] = [
  { chips: [{ outcome: "tp", label: "Тейк" }], note: "торгуем дальше", blocked: false },
  { chips: [{ outcome: "sl", label: "Стоп первым" }], note: "стоп торговля", blocked: true },
];

const CHIP_STYLES: Record<Outcome, string> = {
  tp: "bg-emerald-50 text-emerald-600",
  sl: "bg-red-50 text-red-600",
  day: "bg-surface text-slate-500",
};

/**
 * Правило #20 (запрос пользователя от 17.11.2026): пятый тейк подряд закрывает день и
 * даёт выходной. Серия идёт сквозь дни, обрывает её только стоп; после выходного
 * считается заново.
 */
const TAKE_STREAK_SCENARIOS: Scenario[] = [
  {
    chips: [{ outcome: "tp", label: "5 тейков подряд" }],
    note: "день закрыт, завтра выходной",
    blocked: true,
  },
];

/**
 * Правило #21 (запрос пользователя от 17.11.2026, продолжение серии уточнено в тот же
 * день): крайняя сделка вчера и первая сегодня — обе по стопу → день закрыт и следующий
 * выходной. «Вчера» — последний день со сделками, а не календарный: выходной сделок не
 * содержит, поэтому если день ПОСЛЕ выходного снова начинается со стопа, правило видит
 * тот же стык (крайняя сделка последнего торгового дня — стоп) и срабатывает ещё раз:
 * день закрыт + ещё один выходной. Серию обрывает первая сделка не по стопу.
 */
const EDGE_STOPS_SCENARIOS: Scenario[] = [
  {
    chips: [
      { outcome: "sl", label: "Стоп вчера" },
      { outcome: "sl", label: "Стоп сегодня" },
    ],
    // Совсем коротко: две широкие плашки слева не оставляют места длинной подписи,
    // полная формулировка — в приписке под блоком.
    note: "выходной",
    blocked: true,
  },
  {
    chips: [{ outcome: "sl", label: "Стоп" }],
    note: "первый после выходного — снова выходной",
    blocked: true,
  },
];

function OutcomeChip({ outcome, label }: { outcome: Outcome; label: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${CHIP_STYLES[outcome]}`}>
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
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs text-slate-500">Пятница</p>
        <ul className="flex flex-col">
          {FRIDAY_SCENARIOS.map((scenario, index) => (
            <ScenarioRow key={index} scenario={scenario} />
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs text-slate-500">Понедельник</p>
        <ul className="flex flex-col">
          {WEEKDAY_SCENARIOS.map((scenario, index) => (
            <ScenarioRow key={index} scenario={scenario} />
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs text-slate-500">Суббота</p>
        <ul className="flex flex-col">
          {SATURDAY_SCENARIOS.map((scenario, index) => (
            <ScenarioRow key={index} scenario={scenario} />
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs text-slate-500">Воскресенье</p>
        <ul className="flex flex-col">
          {SUNDAY_SCENARIOS.map((scenario, index) => (
            <ScenarioRow key={index} scenario={scenario} />
          ))}
        </ul>
        <p className="text-[11px] text-slate-400">
          Решает первая сделка: стоп позже воскресенье не закрывает — действуют обычные правила дня.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs text-slate-500">Серия тейков</p>
        <ul className="flex flex-col">
          {TAKE_STREAK_SCENARIOS.map((scenario, index) => (
            <ScenarioRow key={index} scenario={scenario} />
          ))}
        </ul>
        <p className="text-[11px] text-slate-400">
          Подряд — без стопа между ними, дни не важны. После выходного серия заново.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs text-slate-500">Стопы на стыке дней</p>
        <ul className="flex flex-col">
          {EDGE_STOPS_SCENARIOS.map((scenario, index) => (
            <ScenarioRow key={index} scenario={scenario} />
          ))}
        </ul>
        <p className="text-[11px] text-slate-400">
          Крайняя сделка вчера и первая сегодня — обе по стопу: день закрыт, завтра выходной.
          Серия живёт, пока день открывается стопом, — обрывает её первая сделка не по стопу.
        </p>
      </div>
    </section>
  );
}
