import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { serveCallback } from "../../packages/cli/src/auth/session";
import { getCurrentBranch } from "../../packages/cli/src/util/git";

const reachable = (host: string) =>
  fetch(`http://${host}:9999/nope`).then(
    (response) => response.status,
    () => "unreachable"
  );

const callback = Effect.gen(function* () {
  const seen: string[] = [];
  const completed = yield* serveCallback((requestUrl) => {
    seen.push(requestUrl);
    return Promise.resolve();
  });
  const ipv4 = yield* Effect.promise(() => reachable("127.0.0.1"));
  const ipv6 = yield* Effect.promise(() => reachable("[::1]"));
  const page = yield* Effect.promise(async () => {
    const response = await fetch("http://127.0.0.1:9999/callback?code=abc");
    const body = await response.text();
    return {
      status: response.status,
      complete: body.trimEnd().endsWith("</html>"),
    };
  });
  yield* completed;
  return { seen, ipv4, ipv6, page };
}).pipe(Effect.scoped);

const rejected = Effect.gen(function* () {
  const completed = yield* serveCallback(() =>
    Promise.reject(new Error("callback rejected"))
  );
  const status = yield* Effect.promise(() =>
    fetch("http://127.0.0.1:9999/callback?error=denied").then(
      (response) => response.status
    )
  );
  const message = yield* completed.pipe(
    Effect.map(() => null),
    Effect.catchCause((cause) => Effect.succeed(String(cause)))
  );
  return { status, message };
}).pipe(Effect.scoped);

const gitFailure = async () => {
  const root = mkdtempSync(join(tmpdir(), "devver-node-git-"));
  const previous = process.cwd();
  process.chdir(root);
  try {
    await getCurrentBranch();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
};

const summary = {
  callback: await Effect.runPromise(callback),
  rejected: await Effect.runPromise(rejected),
  gitFailure: await gitFailure(),
  bunGlobal: "Bun" in globalThis,
};

process.stdout.write(`${JSON.stringify(summary)}\n`);
