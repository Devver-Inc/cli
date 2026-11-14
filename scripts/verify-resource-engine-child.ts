import { existsSync } from "node:fs";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Effect, Schema } from "effect";
import type { Json } from "effect/Schema";

import {
  EngineBusyError,
  EngineOperationError,
  EngineStateError,
  EngineTeardownRefusal,
  EngineValidationError,
  openResourceEngine,
} from "../packages/server/engine";
import type {
  EngineError,
  ResourceDeclaration,
  ResourceEngine,
  ResourceProvider,
} from "../packages/server/engine";

const nonEmptyText = Schema.String.check(Schema.isNonEmpty());
const [rawMode, rawJournal, rawWork, ...rest] = process.argv.slice(2);
const mode = Schema.decodeUnknownSync(nonEmptyText)(rawMode);
const journal = Schema.decodeUnknownSync(nonEmptyText)(rawJournal);
const work = Schema.decodeUnknownSync(nonEmptyText)(rawWork);
const resourcesDir = join(work, "resources");
const events = join(work, "events.log");

const log = async (line: string) => {
  await appendFile(events, `${line}\n`);
};

const crashIds = new Set(mode.endsWith("-crash") ? rest : []);

const provider: ResourceProvider = {
  id: "files",
  reconcile: ({ id, inputs, previousOutput }) =>
    Effect.promise(async () => {
      if (previousOutput !== undefined) {
        await log(`previous:${id}:${JSON.stringify(previousOutput)}`);
      }
      const file = join(resourcesDir, `${id}.json`);
      await log(`${existsSync(file) ? "reconcile" : "create"}:${id}`);
      await writeFile(file, JSON.stringify(inputs));
      if (crashIds.has(id)) {
        process.kill(process.pid, "SIGKILL");
      }
      return { file: `${id}.json` };
    }),
  remove: ({ id }) =>
    Effect.promise(async () => {
      await rm(join(resourcesDir, `${id}.json`), { force: true });
      await log(`remove:${id}`);
    }),
};

const declaration = (
  id: string,
  inputs: Json,
  protection: "delete" | "retain" = "delete"
): ResourceDeclaration =>
  Schema.decodeSync(
    Schema.Struct({
      id: Schema.String,
      provider: Schema.String,
      inputs: Schema.Json,
      protection: Schema.Literals(["delete", "retain"]),
    })
  )({ id, provider: "files", inputs, protection });

interface GraphSet {
  readonly [mode: string]: readonly ResourceDeclaration[] | undefined;
}

const graphs: GraphSet = {
  main: [
    declaration("database", { engine: "postgres" }),
    declaration("backend", { database: { $ref: "database" } }),
    declaration("frontend", {
      backendFile: { $ref: "backend", output: "file" },
    }),
  ],
  "main-crash": [
    declaration("database", { engine: "postgres" }),
    declaration("backend", { database: { $ref: "database" } }),
  ],
  app1: [declaration("app", { version: 1 })],
  app2: [declaration("app", { version: 2 })],
  "app2-crash": [declaration("app", { version: 2 })],
  backend1: [
    declaration("database-one", {}),
    declaration("backend", { database: { $ref: "database-one" } }),
  ],
  rewire: [
    declaration("database-two", {}),
    declaration("backend", { database: { $ref: "database-two" } }),
  ],
  "rewire-crash": [
    declaration("database-two", {}),
    declaration("backend", { database: { $ref: "database-two" } }),
  ],
  guarded: [declaration("guarded", {}, "retain")],
  smoke: [declaration("left", {}), declaration("right", {})],
};

const isEngineError = (error: unknown): error is EngineError =>
  error instanceof EngineBusyError ||
  error instanceof EngineOperationError ||
  error instanceof EngineStateError ||
  error instanceof EngineTeardownRefusal ||
  error instanceof EngineValidationError;

const errorJson = (error: EngineError) => ({
  _tag: error._tag,
  reason: "reason" in error ? error.reason : undefined,
  id: "id" in error ? error.id : undefined,
  stage: "stage" in error ? error.stage : undefined,
  ids: "ids" in error ? error.ids : undefined,
  message: error.message,
});

const run = async <A>(
  use: (engine: ResourceEngine) => Effect.Effect<A, EngineError>
) =>
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* openResourceEngine({
          path: journal,
          providers: [provider],
          concurrency: 4,
        });
        return yield* use(engine);
      })
    )
  );

type EngineErrorJson = ReturnType<typeof errorJson>;

type ChildEvent =
  | { ok: true; opened: true }
  | { ok: true; resources: readonly { id: string; output: Json }[] }
  | { ok: true; removed: readonly string[] }
  | { ok: false; error: EngineErrorJson }
  | { ok: false; error: { message: string } };

const emit = (payload: ChildEvent) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const main = async () => {
  await mkdir(resourcesDir, { recursive: true });
  if (mode === "hold") {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* openResourceEngine({
            path: journal,
            providers: [provider],
            concurrency: 4,
          });
          yield* Effect.promise(async () => {
            await appendFile(join(work, "holder.log"), "held\n");
          });
          return yield* Effect.never;
        })
      )
    );
    return;
  }
  if (mode === "probe") {
    await run(() => Effect.void);
    emit({ ok: true, opened: true });
    return;
  }
  if (mode === "teardown") {
    const result = await run((engine) => engine.teardown(rest));
    emit({ ok: true, removed: result.removed });
    return;
  }
  const graph = graphs[mode];
  if (graph === undefined) {
    emit({ ok: false, error: { message: `unknown mode ${mode}` } });
    process.exitCode = 1;
    return;
  }
  const result = await run((engine) => engine.apply({ resources: graph }));
  emit({ ok: true, resources: result.resources });
};

try {
  await main();
} catch (error) {
  if (isEngineError(error)) {
    emit({ ok: false, error: errorJson(error) });
    process.exitCode = 1;
  } else {
    throw error;
  }
}
