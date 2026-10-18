#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/devver-local.XXXXXX")
SERVER_PID=
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$RUN"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export XDG_DATA_HOME="$RUN/data"
export XDG_CONFIG_HOME="$RUN/config"
export XDG_CACHE_HOME="$RUN/cache"
export XDG_STATE_HOME="$RUN/state"

(cd "$ROOT" && bun run build)
VERSION=$(cd "$ROOT" && bun -p 'require("./package.json").version')
"$ROOT/servers/$VERSION/devver-server" devtest 0 > "$RUN/server.log" 2>&1 &
SERVER_PID=$!

URL=
for _ in {1..100}; do
  URL=$(grep -Em1 '^http://127\.0\.0\.1:[0-9]+/api/v1$' "$RUN/server.log" || true)
  if [[ -n "$URL" ]]; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    printf 'Local server failed to start\n' >&2
    exit 1
  fi
  sleep 0.1
done
if [[ -z "$URL" ]]; then
  printf 'Local server did not become ready\n' >&2
  exit 1
fi

cat > "$RUN/devver" <<EOF
#!/usr/bin/env bash
export XDG_DATA_HOME=$(printf '%q' "$XDG_DATA_HOME")
export XDG_CONFIG_HOME=$(printf '%q' "$XDG_CONFIG_HOME")
export XDG_CACHE_HOME=$(printf '%q' "$XDG_CACHE_HOME")
export XDG_STATE_HOME=$(printf '%q' "$XDG_STATE_HOME")
exec $(printf '%q' "$ROOT/devver") "\$@"
EOF
chmod 700 "$RUN/devver"
"$RUN/devver" attach "$URL"
printf '\nFrom your website checkout, run:\n  %q deploy\n\nPress Ctrl-C here when done.\n' "$RUN/devver"
wait "$SERVER_PID"
printf 'Local server stopped; run the task again to start a fresh one\n' >&2
exit 1
