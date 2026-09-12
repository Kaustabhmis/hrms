#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Apply the HRMS setup to a Supabase project, from your own machine.
#
#   ./apply.sh "postgresql://postgres:PASSWORD@db.xxxx.supabase.co:5432/postgres"
#
# or put the string in an environment variable and just run ./apply.sh:
#   export SUPABASE_DB_URL="postgresql://..."
#
# It never stores the password. If you would rather not put it on the command
# line at all (where your shell history keeps it), leave it out and psql will
# prompt:
#   ./apply.sh "postgresql://postgres@db.xxxx.supabase.co:5432/postgres"
# ---------------------------------------------------------------------------
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="${1:-${SUPABASE_DB_URL:-}}"

if [ -z "$URL" ]; then
    echo "Usage: ./apply.sh \"postgresql://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres\""
    echo "   or: export SUPABASE_DB_URL=... && ./apply.sh"
    exit 1
fi
if ! command -v psql >/dev/null 2>&1; then
    echo "psql is not installed."
    echo "  macOS:   brew install libpq && brew link --force libpq"
    echo "  Ubuntu:  sudo apt install postgresql-client"
    echo "  Windows: use the Supabase SQL Editor instead — paste supabase/setup.sql."
    exit 1
fi

HOST=$(printf '%s' "$URL" | sed -E 's|.*@([^:/?]+).*|\1|')

# Supabase's direct database hostname is IPv6-only unless the IPv4 add-on is
# bought. Most home and office networks are IPv4-only, so this is the failure
# people hit first, and the error psql gives for it is not obvious.
if [[ "$HOST" == db.*.supabase.co ]]; then
    if ! getent ahostsv4 "$HOST" >/dev/null 2>&1; then
        echo "Note: $HOST has no IPv4 address — Supabase serves direct connections over IPv6 only."
        if ! ping6 -c1 -W2 2606:4700:4700::1111 >/dev/null 2>&1 && ! ping -6 -c1 -W2 2606:4700:4700::1111 >/dev/null 2>&1; then
            echo
            echo "This machine does not appear to have IPv6, so that connection will fail."
            echo "Use the Session Pooler string instead — it is IPv4:"
            echo "  Supabase dashboard -> Connect -> Session pooler"
            echo "  postgresql://postgres.<ref>:PASSWORD@aws-0-<region>.pooler.supabase.com:5432/postgres"
            echo
            echo "Or skip psql entirely: paste supabase/setup.sql into the SQL Editor."
            exit 1
        fi
        echo "This machine has IPv6, so it should be fine."
    fi
fi

echo "Applying setup to $HOST ..."
psql "$URL" -v ON_ERROR_STOP=0 -f "$HERE/setup.sql" 2>&1 \
  | grep -E 'NOTICE|WARNING|ERROR' \
  | sed 's/^psql:[^ ]* //; s/^NOTICE:  //; s/^WARNING:  /!! /'
status=${PIPESTATUS[0]}

if [ "$status" -ne 0 ]; then
    echo
    echo "psql could not connect or the script failed. Common causes:"
    echo "  - wrong password (reset it: dashboard -> Settings -> Database)"
    echo "  - IPv4-only network, as above — use the Session pooler string"
    echo "  - the project is paused (free projects pause after inactivity)"
    exit "$status"
fi
echo
echo "Done. Read the report above — the line that matters is 'tenant tables'."
