#!/bin/sh
# Build the site locally exactly like CI: from Supabase (public anon key in
# js/config.js), never from the SQLite DB that .env points at.
cd "$(dirname "$0")/.." || exit 1
SUPABASE_URL=$(sed -n "s/.*SUPABASE_URL *= *'\(.*\)'.*/\1/p" js/config.js)
SUPABASE_ANON=$(sed -n "s/.*SUPABASE_ANON *= *'\(.*\)'.*/\1/p" js/config.js)
export SUPABASE_URL SUPABASE_ANON DEBUG_DB_PATH=/nonexistent
exec "${PYTHON:-.venv/bin/python}" build_claims.py "$@"
