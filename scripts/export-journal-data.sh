#!/usr/bin/env bash
#
# Выгрузка данных журнала для офлайн-аналитики.
#
# БЕЗОПАСНОСТЬ: скрипт только ЧИТАЕТ. Гарантии, а не обещания:
#   1. PGOPTIONS=-c default_transaction_read_only=on — СЕРВЕР отклонит любую запись,
#      даже если она случайно окажется в тексте скрипта. Это не клиентская проверка.
#   2. Ни одного INSERT/UPDATE/DELETE/DDL — только SELECT и \copy ... TO.
#   3. Таблица settings (зашифрованные ключи BingX, PIN-хэш, VAPID) НЕ выгружается.
#
# Использование:
#   export DATABASE_URL='postgres://...'      # строка подключения к боевой БД
#   ./scripts/export-journal-data.sh          # или: ./scripts/export-journal-data.sh <выходная-папка>
#
set -euo pipefail

OUT_DIR="${1:-data/raw}"
: "${DATABASE_URL:?Нужна переменная DATABASE_URL. Возьми её в Railway: Postgres → Variables → DATABASE_URL (или DATABASE_PUBLIC_URL, если запускаешь не из Railway).}"

# Сервер отклонит любую попытку записи в этой сессии.
export PGOPTIONS='-c default_transaction_read_only=on'

mkdir -p "$OUT_DIR"
echo "Выгрузка в: $OUT_DIR"
echo "Режим: read-only (default_transaction_read_only=on)"
echo

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
\\set QUIET on

-- Сделки: всё, что есть. Закрытые фильтруем уже в анализе — активная/сломанная
-- строка тоже полезна для контроля полноты.
\\copy (SELECT * FROM trades ORDER BY id) TO '$OUT_DIR/trades.csv' CSV HEADER

-- Разборы и чек-листы
\\copy (SELECT * FROM journal_entries ORDER BY id) TO '$OUT_DIR/journal_entries.csv' CSV HEADER
\\copy (SELECT * FROM journal_categories ORDER BY id) TO '$OUT_DIR/journal_categories.csv' CSV HEADER
\\copy (SELECT * FROM journal_checklist_items ORDER BY id) TO '$OUT_DIR/journal_checklist_items.csv' CSV HEADER
\\copy (SELECT * FROM journal_answers ORDER BY id) TO '$OUT_DIR/journal_answers.csv' CSV HEADER

-- Снапшот индикаторов на входе (payload jsonb) — ядро анализа
\\copy (SELECT trade_id, version, computed_at, payload::text AS payload FROM journal_trade_metrics ORDER BY trade_id) TO '$OUT_DIR/journal_trade_metrics.csv' CSV HEADER

-- Свечи: нужны для контрфактической симуляции (шире стоп / ближе тейк / сдвиг входа)
\\copy (SELECT symbol, interval, open_time, open, high, low, close, volume FROM journal_candles ORDER BY symbol, interval, open_time) TO '$OUT_DIR/journal_candles.csv' CSV HEADER
\\copy (SELECT * FROM journal_candle_syncs ORDER BY trade_id, interval) TO '$OUT_DIR/journal_candle_syncs.csv' CSV HEADER

-- Контекст: дневные агрегаты, риск-план, часы, эквити
\\copy (SELECT * FROM daily_stats ORDER BY date) TO '$OUT_DIR/daily_stats.csv' CSV HEADER
\\copy (SELECT * FROM risk_levels ORDER BY level) TO '$OUT_DIR/risk_levels.csv' CSV HEADER
\\copy (SELECT * FROM equity_snapshots ORDER BY date) TO '$OUT_DIR/equity_snapshots.csv' CSV HEADER
\\copy (SELECT * FROM hour_blocks ORDER BY id) TO '$OUT_DIR/hour_blocks.csv' CSV HEADER
\\copy (SELECT * FROM assets ORDER BY id) TO '$OUT_DIR/assets.csv' CSV HEADER
SQL

echo "Готово. Сводка:"
echo

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'trades (всего)'              AS what, count(*)::text AS n FROM trades
UNION ALL SELECT 'trades (закрытых)',  count(*)::text FROM trades WHERE status = 'closed'
UNION ALL SELECT '  из них close_reason=tp',       count(*)::text FROM trades WHERE status='closed' AND close_reason='tp'
UNION ALL SELECT '  из них close_reason=sl',       count(*)::text FROM trades WHERE status='closed' AND close_reason='sl'
UNION ALL SELECT '  из них manual/external',       count(*)::text FROM trades WHERE status='closed' AND close_reason IN ('manual','external')
UNION ALL SELECT 'период сделок',      COALESCE(min(opened_at)::date::text || ' .. ' || max(opened_at)::date::text, '-') FROM trades
UNION ALL SELECT 'символов',           count(DISTINCT symbol)::text FROM trades
UNION ALL SELECT 'разборов (journal_entries)',     count(*)::text FROM journal_entries
UNION ALL SELECT 'категорий',          count(*)::text FROM journal_categories
UNION ALL SELECT 'ответов чек-листа',  count(*)::text FROM journal_answers
UNION ALL SELECT 'снапшотов индикаторов',          count(*)::text FROM journal_trade_metrics
UNION ALL SELECT '  версии снапшотов',  COALESCE(string_agg(DISTINCT version::text, ', '), '-') FROM journal_trade_metrics
UNION ALL SELECT 'свечей',             count(*)::text FROM journal_candles
UNION ALL SELECT 'сделок со свечами',  count(DISTINCT trade_id)::text FROM journal_candle_syncs;
SQL

echo
echo "Файлы:"
ls -lh "$OUT_DIR"
echo
echo "Размер выгрузки: $(du -sh "$OUT_DIR" | cut -f1)"
