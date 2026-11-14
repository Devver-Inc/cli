#!/usr/bin/env bun

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { Schema } from "effect";

const repo = dirname(import.meta.dir);
const child = join(repo, "scripts", "verify-resource-engine-child.ts");
const proofDir = mkdtempSync(join(tmpdir(), "devver-resource-engine-proof-"));
const proofLog = join(proofDir, "proof.log");
const journal = join(proofDir, "journal.sqlite");
const holderJournal = join(proofDir, "holder-journal.sqlite");
const nodeJournal = join(proofDir, "node-journal.sqlite");
const work = join(proofDir, "work");
const holderWork = join(proofDir, "holder-work");
const nodeWork = join(proofDir, "node-work");
mkdirSync(work, { recursive: true });
mkdirSync(holderWork, { recursive: true });
mkdirSync(nodeWork, { recursive: true });

const note = (line: string) => {
  appendFileSync(proofLog, `${line}\n`);
  console.log(line);
};

const fail = (message: string): never => {
  note(`FAIL: ${message}`);
  note(`PROOF_DIR: ${proofDir}`);
  process.exitCode = 1;
  throw new Error(message);
};

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    fail(message);
  }
  note(`ok: ${message}`);
};

interface RunResult {
  code: number | null;
  signal: string | undefined;
  stdout: string;
  stderr: string;
}

const ChildOutputSchema = Schema.Struct({
  ok: Schema.Boolean,
  resources: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, output: Schema.Json }))
  ),
  removed: Schema.optional(Schema.Array(Schema.String)),
  error: Schema.optional(
    Schema.Struct({
      _tag: Schema.String,
      reason: Schema.optional(Schema.String),
      ids: Schema.optional(Schema.Array(Schema.String)),
      message: Schema.String,
    })
  ),
});

type ChildOutput = typeof ChildOutputSchema.Type;

const run = (args: string[], cwd = repo): RunResult => {
  const result = Bun.spawnSync([process.execPath, "run", child, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const record = {
    code: result.exitCode,
    signal: result.signalCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
  note(`run: ${args.join(" ")} -> ${JSON.stringify(record)}`);
  return record;
};

const jsonLine = (result: RunResult): ChildOutput => {
  const line = result.stdout.trim().split("\n").at(-1);
  if (line === undefined) {
    return fail(`child did not print JSON: ${result.stdout}`);
  }
  return Schema.decodeUnknownSync(ChildOutputSchema)(JSON.parse(line));
};

const events = (): string[] =>
  readFileSync(join(work, "events.log"), "utf-8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);

const eventCount = (needle: string): number =>
  events().filter((line) => line === needle).length;

note(`resource engine durable proof started in ${proofDir}`);

const crashed = run(["main-crash", journal, work, "database"]);
assert(
  crashed.signal === "SIGKILL",
  "abrupt apply died by SIGKILL after the side effect"
);
assert(
  existsSync(join(work, "resources", "database.json")),
  "crashed apply left the physical resource behind"
);
assert(
  eventCount("create:database") === 1,
  "crashed apply created the resource once"
);

const recovered = run(["main", journal, work]);
assert(recovered.code === 0, "fresh process recovered the interrupted apply");
const recoveredJson = jsonLine(recovered);
assert(
  JSON.stringify(recoveredJson.resources) ===
    JSON.stringify([
      { id: "database", output: { file: "database.json" } },
      { id: "backend", output: { file: "backend.json" } },
      { id: "frontend", output: { file: "frontend.json" } },
    ]),
  "recovered apply wired literal outputs in order"
);
assert(
  eventCount("create:database") === 1,
  "recovery did not duplicate the resource"
);
assert(
  eventCount("reconcile:database") === 1,
  "recovery reconciled instead of skipping"
);

const rerun = run(["main", journal, work]);
assert(rerun.code === 0, "rerun apply succeeded");
assert(
  eventCount("create:database") === 1,
  "rerun did not duplicate the resource"
);

const appOne = run(["app1", journal, work]);
assert(appOne.code === 0, "first app version applied");
const updateCrash = run(["app2-crash", journal, work, "app"]);
assert(
  updateCrash.signal === "SIGKILL",
  "abrupt update died by SIGKILL after the side effect"
);
const updateRecover = run(["app2", journal, work]);
assert(updateRecover.code === 0, "update retry succeeded");
const previousEvents = events().filter((line) =>
  line.startsWith("previous:app:")
);
assert(
  previousEvents.at(-1) === 'previous:app:{"file":"app.json"}',
  "update retry received the previous output"
);
assert(
  readFileSync(join(work, "resources", "app.json"), "utf-8") ===
    '{"version":2}',
  "update retry wrote the new inputs"
);

const consumerRefusal = run(["teardown", journal, work, "database"]);
assert(consumerRefusal.code !== 0, "teardown of a consumed resource refused");
assert(
  jsonLine(consumerRefusal).error?.reason === "in-use",
  "consumer refusal named the surviving consumer"
);

const backendOne = run(["backend1", journal, work]);
assert(backendOne.code === 0, "backend v1 applied against database-one");
const rewireCrash = run(["rewire-crash", journal, work, "backend"]);
assert(
  rewireCrash.signal === "SIGKILL",
  "abrupt rewire died by SIGKILL after the side effect"
);
const unionRefusal = run(["teardown", journal, work, "database-one"]);
assert(unionRefusal.code !== 0, "teardown of the old dependency was refused");
assert(
  JSON.stringify(jsonLine(unionRefusal).error) ===
    JSON.stringify({
      _tag: "EngineTeardownRefusal",
      reason: "in-use",
      ids: ["database-one"],
      message: "teardown names a resource that is still in use",
    }),
  "union edge blocked teardown of the still-used old dependency"
);
const rewire = run(["rewire", journal, work]);
assert(rewire.code === 0, "rewire retry succeeded");
const oldDependency = run(["teardown", journal, work, "database-one"]);
assert(
  oldDependency.code === 0,
  "old dependency became deletable after the rewire succeeded"
);

const guarded = run(["guarded", journal, work]);
assert(guarded.code === 0, "protected resource applied");
const guardedRefusal = run(["teardown", journal, work, "guarded"]);
assert(guardedRefusal.code !== 0, "protected teardown refused");
assert(
  jsonLine(guardedRefusal).error?.reason === "protected",
  "protected refusal named the protection policy"
);

const teardown = run([
  "teardown",
  journal,
  work,
  "database",
  "backend",
  "frontend",
]);
assert(teardown.code === 0, "full teardown succeeded");
assert(
  JSON.stringify(jsonLine(teardown).removed) ===
    JSON.stringify(["frontend", "backend", "database"]),
  "teardown removed in reverse dependency order"
);
const removeOrder = events()
  .filter((line) => line.startsWith("remove:"))
  .slice(-3);
assert(
  JSON.stringify(removeOrder) ===
    JSON.stringify(["remove:frontend", "remove:backend", "remove:database"]),
  "provider removes ran in reverse dependency order"
);
const retryTeardown = run([
  "teardown",
  journal,
  work,
  "database",
  "backend",
  "frontend",
]);
assert(retryTeardown.code === 0, "teardown retry succeeded");
assert(
  JSON.stringify(jsonLine(retryTeardown).removed) === JSON.stringify([]),
  "teardown retry removed nothing"
);
for (const id of ["database-two", "app"]) {
  const cleanup = run(["teardown", journal, work, id]);
  assert(cleanup.code === 0, `teardown removed ${id}`);
}

const holderSignal = join(holderWork, "holder.log");
const holder = Bun.spawn(
  [process.execPath, "run", child, "hold", holderJournal, holderWork],
  { cwd: repo, stdout: "pipe", stderr: "pipe" }
);
let held = false;
try {
  for (let attempt = 0; attempt < 100 && !held; attempt += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    held = existsSync(holderSignal);
  }
  assert(held, "holder process claimed the journal");
  const busyProbe = run(["probe", holderJournal, holderWork]);
  assert(
    busyProbe.code !== 0,
    "second writer was rejected while the holder lived"
  );
  assert(
    jsonLine(busyProbe).error?._tag === "EngineBusyError",
    "second writer saw the busy error"
  );
} finally {
  holder.kill("SIGKILL");
  await holder.exited;
}
const reclaimedProbe = run(["probe", holderJournal, holderWork]);
assert(
  reclaimedProbe.code === 0,
  "writer was reclaimed after the holder was definitely dead"
);

const node =
  Bun.which("node") ??
  fail("node is required for the Node-bundled engine proof");
const bundle = join(proofDir, "node-driver.mjs");
const build = Bun.spawnSync(
  [
    "bun",
    "build",
    child,
    "--target=node",
    "--format=esm",
    "--external",
    "@effect/sql-sqlite-bun/SqliteClient",
    `--outfile=${bundle}`,
  ],
  { cwd: repo, stdout: "pipe", stderr: "pipe" }
);
if (build.exitCode !== 0) {
  fail(`node bundle build failed: ${build.stderr.toString()}`);
}
const bundleCode = readFileSync(bundle, "utf-8");
assert(
  !/\bBun\s*\.\s*(?<api>serve|spawn|stderr|stdout|file|color|build)\b/u.test(
    bundleCode
  ),
  "node bundle contains no Bun API calls"
);
assert(
  !bundleCode.includes("bun:sqlite"),
  "node bundle does not reach bun:sqlite"
);
const nodeRun = Bun.spawnSync([node, bundle, "smoke", nodeJournal, nodeWork], {
  cwd: proofDir,
  env: {
    HOME: process.env.HOME ?? proofDir,
    PATH: [dirname(node)].join(delimiter),
  },
  stdout: "pipe",
  stderr: "pipe",
});
note(
  `node run -> code=${nodeRun.exitCode} stdout=${nodeRun.stdout.toString()} stderr=${nodeRun.stderr.toString()}`
);
assert(
  nodeRun.exitCode === 0,
  "node-bundled engine applied a graph under node without bun"
);
const nodeTeardown = Bun.spawnSync(
  [node, bundle, "teardown", nodeJournal, nodeWork, "left", "right"],
  {
    cwd: proofDir,
    env: {
      HOME: process.env.HOME ?? proofDir,
      PATH: [dirname(node)].join(delimiter),
    },
    stdout: "pipe",
    stderr: "pipe",
  }
);
note(
  `node teardown -> code=${nodeTeardown.exitCode} stdout=${nodeTeardown.stdout.toString()}`
);
assert(
  nodeTeardown.exitCode === 0,
  "node-bundled engine tore the graph down under node"
);

note("resource engine durable proof passed");
note(`PROOF_DIR: ${proofDir}`);
