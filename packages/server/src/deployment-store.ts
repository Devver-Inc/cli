/**
 * Durable deployment records.
 *
 * SQLite reaches both distributions through the runtime that loads this
 * module: the npm server bundle runs under Node and uses `node:sqlite`, the
 * compiled server runs under Bun and uses `bun:sqlite`. Neither bundler
 * resolves the computed specifier, so each artifact keeps only its own
 * built-in driver and no SQLite dependency ships with either.
 */

import { lstat, open } from "node:fs/promises";

import { Schema } from "effect";

const PRIVATE_FILE = 0o600;

export const DeployStageSchema = Schema.Literals([
  "server",
  "source",
  "git",
  "config",
  "process",
  "readiness",
]);

export type DeployStage = typeof DeployStageSchema.Type;

const identity = {
  deploymentId: Schema.String.check(Schema.isUUID(4)),
  repositoryId: Schema.String.check(Schema.isNonEmpty()),
  commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
  parentDeploymentId: Schema.NullOr(Schema.String.check(Schema.isUUID(4))),
  worktree: Schema.String.check(Schema.isNonEmpty()),
};

const NewDeploymentSchema = Schema.Struct(identity);

/** Ports are TEXT on the way in and out, like every other column. */
const PortSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 65_535 })
);

const DeploymentSchema = Schema.Struct({
  ...identity,
  status: Schema.Literals(["preparing", "ready", "failed", "degraded"]),
  stage: Schema.NullOr(DeployStageSchema),
  sitePort: Schema.NullOr(PortSchema),
  createdAt: Schema.String,
});

export type Deployment = typeof DeploymentSchema.Type;

export type NewDeployment = typeof NewDeploymentSchema.Type;

const decodeNewDeployment = Schema.decodeUnknownSync(NewDeploymentSchema);
const decodeDeployment = Schema.decodeUnknownSync(DeploymentSchema);
const encodePort = Schema.encodeUnknownSync(PortSchema);
const decodePort = Schema.decodeUnknownSync(PortSchema);

const APP_PORT = "appPort";

/** Every column is TEXT, so a row carries only strings and SQL nulls. */
type SqlValue = string | null;
type SqlRow = Readonly<Record<string, SqlValue>>;

interface SqliteStatement {
  readonly run: (...parameters: SqlValue[]) => void;
  readonly all: (...parameters: SqlValue[]) => readonly SqlRow[];
}

interface SqliteDatabase {
  readonly exec: (sql: string) => void;
  readonly prepare: (sql: string) => SqliteStatement;
  readonly close: () => void;
}

type SqliteConstructor = new (path: string) => SqliteDatabase;

/** `node:sqlite` names the class `DatabaseSync`; `bun:sqlite` names it `Database`. */
interface SqliteModule {
  readonly DatabaseSync?: SqliteConstructor;
  readonly Database?: SqliteConstructor;
}

/**
 * Which SQLite class a runtime offers is the only variable part: both are
 * built in, so their documented synchronous API is as trusted as `node:fs`,
 * while the rows they return are decoded like any other external input.
 */
const isSqliteModule = (value: unknown): value is SqliteModule =>
  typeof value === "object" &&
  value !== null &&
  (("DatabaseSync" in value && typeof value.DatabaseSync === "function") ||
    ("Database" in value && typeof value.Database === "function"));

/** The record file is created owner-only before any driver can widen it. */
async function privateFile(path: string) {
  const handle = await open(path, "a", PRIVATE_FILE);
  await handle.close();
  if (process.platform === "win32") {
    return;
  }
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    stat.mode % 0o1000 !== PRIVATE_FILE
  ) {
    throw new Error("Deployment records must be an owner-only regular file");
  }
}

/**
 * Open (creating if absent) the deployment records of one server instance.
 * Rows are decoded on the way out, so a corrupt row fails instead of becoming
 * a half-known deployment.
 */
export async function openDeploymentStore(path: string) {
  await privateFile(path);
  const loaded: unknown = await import(
    process.versions.bun === undefined ? "node:sqlite" : "bun:sqlite"
  );
  const construct = isSqliteModule(loaded)
    ? (loaded.DatabaseSync ?? loaded.Database)
    : undefined;
  if (construct === undefined) {
    throw new Error("No SQLite driver is available in this runtime");
  }
  const database = new construct(path);
  database.exec(`CREATE TABLE IF NOT EXISTS deployments (
    deploymentId TEXT PRIMARY KEY NOT NULL,
    repositoryId TEXT NOT NULL,
    commitSha TEXT NOT NULL,
    parentDeploymentId TEXT REFERENCES deployments(deploymentId),
    worktree TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT,
    sitePort TEXT,
    createdAt TEXT NOT NULL
  ) STRICT`);
  try {
    // Records written before deployments were reconciled on restart have no
    // site port; adding the column keeps those deployments readable.
    database.exec("ALTER TABLE deployments ADD COLUMN sitePort TEXT");
  } catch {
    // oxlint-disable-next-line eslint/preserve-caught-error -- The only expected failure is the column already existing.
  }
  database.exec(`CREATE TABLE IF NOT EXISTS instance (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  ) STRICT`);
  const statement = (sql: string) => database.prepare(sql);
  const insert = statement(
    `INSERT INTO deployments
     (deploymentId, repositoryId, commitSha, parentDeploymentId, worktree, status, stage, createdAt)
     VALUES (?, ?, ?, ?, ?, 'preparing', NULL, ?)`
  );
  const setStatus = statement(
    "UPDATE deployments SET status = ?, stage = ?, sitePort = ? WHERE deploymentId = ?"
  );
  const columns = `deploymentId, repositoryId, commitSha AS "commit", parentDeploymentId,
            worktree, status, stage, sitePort, createdAt`;
  const select = statement(
    `SELECT ${columns} FROM deployments WHERE deploymentId = ?`
  );
  const selectAll = statement(
    `SELECT ${columns} FROM deployments ORDER BY createdAt, deploymentId`
  );
  const setSetting = statement(
    "INSERT INTO instance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  const selectSetting = statement("SELECT value FROM instance WHERE key = ?");
  return {
    record: (input: NewDeployment) => {
      const deployment = decodeNewDeployment(input);
      insert.run(
        deployment.deploymentId,
        deployment.repositoryId,
        deployment.commit,
        deployment.parentDeploymentId,
        deployment.worktree,
        new Date().toISOString()
      );
    },
    markReady: (deploymentId: string, sitePort: number) => {
      setStatus.run("ready", null, encodePort(sitePort), deploymentId);
    },
    markFailed: (deploymentId: string, stage: DeployStage) => {
      setStatus.run("failed", stage, null, deploymentId);
    },
    /** Recorded intent the server could not serve again: no port, no route. */
    markDegraded: (deploymentId: string, stage: DeployStage) => {
      setStatus.run("degraded", stage, null, deploymentId);
    },
    read: (deploymentId: string): Deployment | undefined => {
      const [row] = select.all(deploymentId);
      return row === undefined ? undefined : decodeDeployment(row);
    },
    /**
     * Every record this runtime can trust, plus how many it cannot. A row that
     * fails to decode is counted, never rewritten: a half-known deployment
     * must not overwrite the record of an earlier one.
     */
    list: () => {
      const deployments: Deployment[] = [];
      let unreadable = 0;
      for (const row of selectAll.all()) {
        try {
          deployments.push(decodeDeployment(row));
        } catch {
          unreadable += 1;
        }
      }
      return { deployments, unreadable };
    },
    /** The loopback port every deployment URL of this instance is published on. */
    appPort: (): number | undefined => {
      const [row] = selectSetting.all(APP_PORT);
      return row === undefined ? undefined : decodePort(row.value);
    },
    setAppPort: (port: number) => {
      setSetting.run(APP_PORT, encodePort(port));
    },
    close: () => {
      database.close();
    },
  };
}
