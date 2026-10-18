#!/usr/bin/env bash
set -euo pipefail

FEATURE=${1:-}
case "$FEATURE" in
  attach|deploy|switch) ;;
  *) printf 'Usage: bash .pi/skills/verify-devver-cli/verify.sh attach|deploy|switch\n' >&2; exit 2 ;;
esac

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/devver-verify-run.XXXXXX")
PROOF=$(mktemp -d "${TMPDIR:-/tmp}/devver-verify-proof.XXXXXX")
NAME=verify-static
umask 077
export XDG_DATA_HOME="$RUN/state" XDG_CONFIG_HOME="$RUN/config" XDG_CACHE_HOME="$RUN/cache" XDG_STATE_HOME="$RUN/runtime"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -f "$RUN/server.log" ]]; then cp "$RUN/server.log" "$PROOF/server.log"; fi
  rm -rf "$RUN"
  printf 'Proof retained at %s\n' "$PROOF"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Feature: %s\nRepo: %s\n' "$FEATURE" "$REPO" | tee "$PROOF/actions.txt"
(cd "$REPO" && bun run build:npm) > "$PROOF/build.log" 2>&1
bun run "$REPO/packages/server/src/index.ts" "$NAME" 0 > "$RUN/server.log" 2>&1 &
SERVER_PID=$!
URL=
for _ in {1..100}; do
  if [[ -s "$RUN/server.log" ]]; then
    URL=$(grep -Em1 '^http://127\.0\.0\.1:[0-9]+/api/v1$' "$RUN/server.log" || true)
    if [[ -n "$URL" ]]; then break; fi
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  sleep 0.1
done
if [[ -z "$URL" ]]; then printf 'Server did not announce its control URL\n' >&2; exit 1; fi
printf 'Control URL: %s\n' "$URL" | tee -a "$PROOF/actions.txt"

bun run "$REPO/packages/cli/src/cli/index.ts" --version > "$PROOF/version.txt" 2>&1
curl --fail --silent --show-error "$URL/identity" > "$PROOF/identity.json"
grep -Fq '"name":"verify-static"' "$PROOF/identity.json"
printf 'Doctor: CLI version and matching isolated server identity answered.\n' | tee -a "$PROOF/actions.txt"

cli() {
  printf 'devver' | tee -a "$PROOF/actions.txt"
  printf ' %q' "$@" | tee -a "$PROOF/actions.txt"
  printf '\n' | tee -a "$PROOF/actions.txt"
  local status
  set +e
  bun run "$REPO/packages/cli/src/cli/index.ts" "$@" 2>&1 | tee -a "$PROOF/actions.txt"
  status=${PIPESTATUS[0]}
  set -e
  printf 'Exit code: %s\n' "$status" | tee -a "$PROOF/actions.txt"
  return "$status"
}

cd "$RUN"
cli attach "$URL"
cli server status
if [[ "$FEATURE" == deploy ]]; then
  mkdir site
  cd site
  git init -q -b main
  git config user.name 'Devver Verify'
  git config user.email 'verify@devver.invalid'
  printf '<h1>committed static page</h1>\n' > index.html
  git add index.html
  git commit -qm 'Static fixture'
  git rev-parse HEAD > "$PROOF/selected-head.txt"
  printf '<h1>uncommitted edit</h1>\n' > index.html
  cli deploy | tee "$PROOF/deploy.txt"
  grep -Fq "Commit: $(< "$PROOF/selected-head.txt")" "$PROOF/deploy.txt"
  APP_URL=$(grep -Eo 'http://[a-f0-9-]{36}\.localhost:[0-9]+/' "$PROOF/deploy.txt" | tail -1)
  [[ -n "$APP_URL" ]]
  APP_PORT=${APP_URL%/}
  APP_PORT=${APP_PORT##*:}
  CONTROL_PORT=${URL%/api/v1}
  CONTROL_PORT=${CONTROL_PORT##*:}
  [[ "$APP_PORT" != "$CONTROL_PORT" ]]
  curl --fail --silent --show-error "$APP_URL" > "$PROOF/app-response.html"
  grep -Fxq '<h1>committed static page</h1>' "$PROOF/app-response.html"
  DEPLOYMENT_ID=$(grep -Eo 'Deployment ID: [a-f0-9-]{36}' "$PROOF/deploy.txt" | tail -1)
  DEPLOYMENT_ID=${DEPLOYMENT_ID##* }
  [[ "$APP_URL" == "http://$DEPLOYMENT_ID.localhost:$APP_PORT/" ]]
  bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.argv[1], { readonly: true });
    const row = db.query("SELECT deploymentId, commitSha, status FROM deployments WHERE deploymentId = ?").get(process.argv[2]);
    db.close();
    if (row?.commitSha !== process.argv[3] || row.status !== "ready") throw new Error("Persisted deployment differs from the printed result");
    console.log(JSON.stringify(row));
  ' "$XDG_DATA_HOME/devver/servers/$NAME/deployments.sqlite" "$DEPLOYMENT_ID" "$(< "$PROOF/selected-head.txt")" > "$PROOF/deployment-record.json"
  printf 'Fetched %s and confirmed committed content and the persisted ready record.\n' "$APP_URL" | tee -a "$PROOF/actions.txt"
elif [[ "$FEATURE" == switch ]]; then
  cli cloud
  cli config list
  cli detach
  cli server status
  grep -Fq 'No server attached' "$PROOF/actions.txt"
else
  cli detach
  cli server status
  grep -Fq 'No server attached' "$PROOF/actions.txt"
fi
printf 'PASS %s\n' "$FEATURE" | tee -a "$PROOF/actions.txt"
