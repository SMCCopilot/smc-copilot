#!/usr/bin/env bash
# Apply the MVP migrations in order.
#   Local / CI (plain Postgres 15+):  ./apply.sh "postgresql://postgres:postgres@localhost:5432/smc" --with-shims
#   Supabase (direct connection):     ./apply.sh "postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres"
# Add --with-upgrade to also apply upgrade/0010_full_product_additions.sql (Set A tables the MVP omits; milestone M6).
# Add --with-forex to also apply upgrade/0011_forex_enable.sql (milestone M10-B, only after gate G7).
set -euo pipefail
URL="${1:?usage: apply.sh <database-url> [--with-shims] [--with-upgrade] [--with-forex]}"
shift || true
cd "$(dirname "$0")"
FILES=(0001_identity 0002_market 0003_engine 0004_sessions_trades 0005_ai 0006_platform 0007_maintenance 0008_rls 0009_seed_reference)
for a in "$@"; do [[ "$a" == "--with-shims" ]] && psql "$URL" -v ON_ERROR_STOP=1 -q -f 0000_dev_shims.sql; done
for f in "${FILES[@]}"; do echo "applying $f"; psql "$URL" -v ON_ERROR_STOP=1 -q -f "$f.sql"; done
for a in "$@"; do [[ "$a" == "--with-upgrade" ]] && { echo "applying upgrade/0010"; psql "$URL" -v ON_ERROR_STOP=1 -q -f upgrade/0010_full_product_additions.sql; }; done
for a in "$@"; do [[ "$a" == "--with-forex" ]] && { echo "applying upgrade/0011"; psql "$URL" -v ON_ERROR_STOP=1 -q -f upgrade/0011_forex_enable.sql; }; done
echo "done. optional smoke test: psql \"$URL\" -f tests/b03_smoke_test.sql   (local only: it inserts auth.users rows)"
