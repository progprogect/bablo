#!/usr/bin/env bash
#
# Одна команда: достать строку подключения, выгрузить данные, вернуть их в репозиторий.
#
# БЕЗОПАСНОСТЬ: всё, что делается с БД, — только чтение. Выгрузку выполняет
# export-journal-data.sh, который открывает сессию с default_transaction_read_only=on:
# любую попытку записи отклонит сам PostgreSQL. Таблица settings (ключи BingX, PIN,
# VAPID) не выгружается.
#
# Использование:
#   ./scripts/pull-journal-data.sh                      # спросит, что не найдёт
#   DATABASE_URL='postgres://...' ./scripts/pull-journal-data.sh
#   RAILWAY_TOKEN='...' ./scripts/pull-journal-data.sh  # попробует достать сам
#   ./scripts/pull-journal-data.sh --no-push            # не предлагать git push
#
set -euo pipefail

cd "$(dirname "$0")/.."
OUT_DIR="data/raw"
DO_PUSH=1
[[ "${1:-}" == "--no-push" ]] && DO_PUSH=0

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\033[31mОшибка: %s\033[0m\n' "$*" >&2; exit 1; }

# --- 1. Проверка инструментов ------------------------------------------------------------
say "1/5  Проверяю инструменты"
command -v psql >/dev/null || die "нет psql. macOS: brew install libpq && brew link --force libpq
                Ubuntu: sudo apt install postgresql-client"
echo "  psql: $(psql --version)"

# --- 2. Строка подключения ---------------------------------------------------------------
say "2/5  Ищу строку подключения"

DB_URL="${DATABASE_PUBLIC_URL:-${DATABASE_URL:-}}"

if [[ -z "$DB_URL" && -n "${RAILWAY_TOKEN:-}" ]] && command -v railway >/dev/null; then
  echo "  Пробую через Railway CLI..."
  for svc in Postgres postgres PostgreSQL PGDATABASE; do
    if vars=$(railway variables --service "$svc" --kv 2>/dev/null); then
      DB_URL=$(printf '%s\n' "$vars" | sed -n 's/^DATABASE_PUBLIC_URL=//p' | head -1)
      [[ -z "$DB_URL" ]] && DB_URL=$(printf '%s\n' "$vars" | sed -n 's/^DATABASE_URL=//p' | head -1)
      [[ -n "$DB_URL" ]] && { echo "  Нашёл в сервисе '$svc'."; break; }
    fi
  done
fi

if [[ -z "$DB_URL" ]]; then
  warn "  Автоматически не нашёл — нужен один copy-paste."
  cat <<'HINT'

  Railway -> твой проект -> сервис Postgres -> вкладка Variables
  Скопируй значение DATABASE_PUBLIC_URL (именно PUBLIC — обычный DATABASE_URL
  указывает на внутренний хост, который снаружи Railway не резолвится).

HINT
  read -r -p "  Вставь строку подключения: " DB_URL
  [[ -n "$DB_URL" ]] || die "пустая строка подключения"
fi

if [[ "$DB_URL" == *".railway.internal"* ]]; then
  warn "  ВНИМАНИЕ: это ВНУТРЕННИЙ хост Railway."
  warn "  С локальной машины он не резолвится — нужен DATABASE_PUBLIC_URL."
  die "смени строку на публичную (Postgres -> Variables -> DATABASE_PUBLIC_URL)"
fi

# --- 3. Проба связи ----------------------------------------------------------------------
say "3/5  Проверяю связь с базой (только чтение)"
export PGOPTIONS='-c default_transaction_read_only=on'
export PGCONNECT_TIMEOUT=15
if ! probe=$(psql "$DB_URL" -tAc "SELECT current_database() || ' @ ' || version()" 2>&1); then
  printf '%s\n' "$probe" >&2
  die "подключиться не удалось (см. сообщение выше)"
fi
echo "  OK: ${probe:0:80}..."

n_trades=$(psql "$DB_URL" -tAc "SELECT count(*) FROM trades WHERE status='closed'" 2>/dev/null || echo "?")
echo "  Закрытых сделок в базе: $n_trades"
if [[ "$n_trades" == "0" ]]; then
  die "закрытых сделок нет — выгружать нечего"
fi

# --- 4. Выгрузка -------------------------------------------------------------------------
say "4/5  Выгружаю в $OUT_DIR"
DATABASE_URL="$DB_URL" ./scripts/export-journal-data.sh "$OUT_DIR"

# --- 5. Вернуть данные в репозиторий -----------------------------------------------------
say "5/5  Передача данных"
if [[ "$DO_PUSH" == "0" ]]; then
  echo "  Пропущено (--no-push). Файлы лежат в $OUT_DIR"
  exit 0
fi

branch=$(git rev-parse --abbrev-ref HEAD)
size=$(du -sh "$OUT_DIR" | cut -f1)
cat <<EOF

  Выгрузка: $size в $OUT_DIR
  Ветка:    $branch

  Это РЕАЛЬНАЯ история сделок. Коммит в git сохранит её навсегда.
  Репозиторий приватный, ветка рабочая — но решение твоё.

EOF
# case вместо ${answer,,}: на macOS по умолчанию bash 3.2, где ,, не поддерживается
read -r -p "  Закоммитить и запушить данные? [y/N]: " answer
case "$answer" in
  [yY]|[yY][eE][sS]|[dD]|[dD][aA]) confirmed=1 ;;
  *) confirmed=0 ;;
esac
if [[ "$confirmed" == "1" ]]; then
  git add -f "$OUT_DIR"
  git commit -q -m "Выгрузка журнала для анализа ($n_trades закрытых сделок)"
  git push -u origin "$branch"
  echo "  Готово — данные в ветке $branch."
else
  echo "  Не коммичу. Файлы остаются в $OUT_DIR"
fi
