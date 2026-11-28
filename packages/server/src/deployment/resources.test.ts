import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import type { HttpClient } from "effect/http";
import { FetchHttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { EngineOperationError } from "../../engine";
import type { EngineError } from "../../engine";
import type { DeployFailure } from "../api";
import { DeploymentHost } from "../deployment-host";
import type { HostService } from "../deployment-host";
import { DeploymentStore } from "../deployment-store";
import type { StoreService } from "../deployment-store";
import { Git, GitFailure, openGit } from "../git-source";
import type { GitService } from "../git-source";
import type { InstanceDirectoryService } from "../instance-directory";
import { InstanceDirectory } from "../instance-directory";
import type { StaticDeploymentTarget } from "./create";
import {
  destroyDeployment,
  deploymentResources,
  deployFailureOf,
  enginesLayer,
  Engines,
  WorkspaceId,
} from "./resources";
import type { EnginesService } from "./resources";
import type { DeploymentSpecification } from "./specification";

const childProcesses = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(NodePath.layer)
);

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

const isLoopbackBinding = (
  bound: AddressInfo | string | null
): bound is AddressInfo => bound !== null && typeof bound === "object";

const answerServer = async () =>
  new Promise<{ http: Server; port: number }>((resolve, reject) => {
    const http = createServer((_request, response) => {
      response.statusCode = 200;
      response.end("published");
    });
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      const bound = http.address();
      if (!isLoopbackBinding(bound)) {
        reject(new Error("the answer server did not bind a loopback port"));
        return;
      }
      resolve({ http, port: bound.port });
    });
  });

interface Kit {
  readonly instance: string;
  readonly checkout: string;
  readonly commit: string;
  readonly answerPort: number;
  readonly http: Server;
  readonly events: string[];
  readonly gitCalls: Record<string, number>;
  readonly committed: string;
  storeStatus: (deploymentId: string) => "preparing" | "ready";
  statuses: Record<string, "preparing" | "ready">;
  readonly specifications: Map<string, DeploymentSpecification>;
  slowReserve: boolean;
  unreadableConfig: boolean;
  slowPublish: boolean;
  cleanup: () => void;
}

const makeKit = async (committed = "static: {}\n"): Promise<Kit> => {
  const instance = mkdtempSync(join(tmpdir(), "devver-resources-"));
  const checkout = mkdtempSync(join(tmpdir(), "devver-resources-source-"));
  const events: string[] = [];
  const gitCalls: Record<string, number> = {};
  run(checkout, "init", "--quiet");
  run(checkout, "config", "user.name", "Devver");
  run(checkout, "config", "user.email", "devver@localhost");
  writeFileSync(join(checkout, ".devver.yaml"), committed);
  run(checkout, "add", ".");
  run(checkout, "commit", "--quiet", "-m", "one");
  const commit = run(checkout, "rev-parse", "HEAD");
  const answered = await answerServer();
  const cleanup = () => {
    answered.http.close();
    rmSync(instance, { recursive: true, force: true });
  };
  const probe: Kit = {
    instance,
    checkout,
    commit,
    answerPort: answered.port,
    http: answered.http,
    events,
    gitCalls,
    storeStatus: (deploymentId: string) =>
      probe.statuses[deploymentId] ?? "preparing",
    statuses: {},
    specifications: new Map(),
    slowReserve: false,
    unreadableConfig: false,
    committed,
    slowPublish: false,
    cleanup,
  };
  probe.storeStatus = (deploymentId: string) =>
    probe.statuses[deploymentId] ?? "preparing";
  return probe;
};

const targetOf = (
  probe: Kit,
  deploymentId: string
): StaticDeploymentTarget => ({
  deploymentId,
  repositoryId: "1".repeat(64),
  commit: probe.commit,
  originKind: "checkout",
  originPath: probe.checkout,
});

// Shares the one counting implementation across wrapped methods, so each
// Git call is observable without recreating a counting closure.
const recorded = (probe: Kit, name: string) => {
  probe.gitCalls[name] = (probe.gitCalls[name] ?? 0) + 1;
  probe.events.push(`git:${name}`);
};

// Real Git over the server's own repositories, wrapped to count calls.
const countingGit = (probe: Kit): Layer.Layer<GitService> =>
  Layer.effect(
    Git,
    Effect.map(
      openGit({
        repositories: join(probe.instance, "repositories"),
        worktrees: join(probe.instance, "worktrees"),
      }),
      (git: GitService) =>
        ({
          verifiedSource: (source, commit) => {
            recorded(probe, "verifiedSource");
            return git.verifiedSource(source, commit);
          },
          firstParentDeployment: (source, commit, candidates) => {
            recorded(probe, "firstParentDeployment");
            return git.firstParentDeployment(source, commit, candidates);
          },
          mergeCommits: (input) => {
            recorded(probe, "mergeCommits");
            return git.mergeCommits(input);
          },
          prepareWorktree: (input) => {
            recorded(probe, "prepareWorktree");
            return git.prepareWorktree(input);
          },
          inspectWorktree: (input) => {
            recorded(probe, "inspectWorktree");
            return git.inspectWorktree(input);
          },
          subjectsOf: (entries) => {
            recorded(probe, "subjectsOf");
            return git.subjectsOf(entries);
          },
          committedFile: (repositoryId, commit, path) => {
            recorded(probe, "committedFile");
            if (probe.unreadableConfig) {
              return Effect.fail(
                new GitFailure({ message: "config unavailable" })
              );
            }
            return git.committedFile(repositoryId, commit, path);
          },
          removeWorktree: (repositoryId, worktree) => {
            recorded(probe, "removeWorktree");
            return git.removeWorktree(repositoryId, worktree);
          },
          removeDeploymentRef: (repositoryId, deploymentId) => {
            recorded(probe, "removeDeploymentRef");
            return git.removeDeploymentRef(repositoryId, deploymentId);
          },
        }) satisfies GitService
    )
  );

type HarnessServices =
  | EnginesService
  | GitService
  | HostService
  | StoreService
  | InstanceDirectoryService
  | ChildProcessSpawner
  | (typeof HttpClient.HttpClient extends never
      ? never
      : Effect.Success<typeof HttpClient.HttpClient>);

const deploymentsHarness = (probe: Kit): Layer.Layer<HarnessServices> => {
  const hostService: HostService = {
    reserve: (deploymentId) =>
      Effect.gen(function* () {
        probe.events.push(`reserve:${deploymentId}`);
        if (probe.slowReserve) {
          return yield* Effect.never;
        }
        const directory = join(probe.instance, "slot", deploymentId);
        mkdirSync(directory, { recursive: true });
        return {
          port: 45_678,
          directory,
        };
      }),
    publish: (deploymentId) =>
      Effect.andThen(
        probe.slowPublish ? Effect.sleep(400) : Effect.void,
        Effect.sync(() => {
          probe.events.push(`publish:${deploymentId}:${Date.now()}`);
        })
      ),
    withdraw: (deploymentId) =>
      Effect.sync(() => {
        probe.events.push(`withdraw:${deploymentId}`);
      }),
    url: (deploymentId) =>
      `http://127.0.0.1:${probe.answerPort}/${deploymentId}/`,
    proxyPort: probe.answerPort,
  };
  const storeService: StoreService = {
    record: () => Effect.void,
    readSpecification: (deploymentId) =>
      Effect.sync(() => probe.specifications.get(deploymentId)),
    recordSpecification: (deploymentId, specification) =>
      Effect.sync(() => {
        const recordedSpecification =
          probe.specifications.get(deploymentId) ?? specification;
        probe.specifications.set(deploymentId, recordedSpecification);
        return recordedSpecification;
      }),
    rename: () => Effect.succeed(false),
    markReady: () => Effect.void,
    markFailed: () => Effect.void,
    markDegraded: () => Effect.void,
    read: (deploymentId) =>
      Effect.succeed({
        deploymentId,
        repositoryId: "1".repeat(64),
        commit: probe.commit,
        parentDeploymentId: null,
        secondParentDeploymentId: null,
        worktree: join(probe.instance, "worktrees", deploymentId),
        status: probe.storeStatus(deploymentId),
        stage: null,
        displayName: null,
        source: probe.checkout,
        lifecycle: "workflow",
        createdAt: new Date().toISOString(),
      }),
    list: Effect.succeed({ deployments: [], unreadable: 0 }),
    // oxlint-disable-next-line effecttsgo/effect-succeed-with-void -- the unsaved app port is a genuinely undefined value, not a void effect.
    appPort: Effect.succeed<number | undefined>(undefined),
    setAppPort: () => Effect.void,
  };
  const fakes = Layer.mergeAll(
    countingGit(probe),
    Layer.effect(DeploymentHost, Effect.succeed(hostService)),
    Layer.effect(DeploymentStore, Effect.succeed(storeService))
  );
  const directory = Layer.succeed(InstanceDirectory, {
    directory: probe.instance,
    worktrees: join(probe.instance, "worktrees"),
    repositories: join(probe.instance, "repositories"),
  });
  const transports = Layer.mergeAll(FetchHttpClient.layer, childProcesses);
  const composed = Layer.mergeAll(
    enginesLayer.pipe(
      Layer.provide(fakes),
      Layer.provide(directory),
      Layer.provide(transports)
    ),
    fakes,
    directory,
    transports
  ).pipe(Layer.orDie);
  return composed;
};

const failureOr = (
  error: Option.Option<EngineError>
): DeployFailure | undefined =>
  Option.isSome(error) && error.value instanceof EngineOperationError
    ? deployFailureOf(error.value)
    : undefined;

const useEngines = async <A>(
  probe: Kit,
  program: (engines: EnginesService) => Effect.Effect<A, never, HarnessServices>
) =>
  await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Engines, program).pipe(
        Effect.orDie,
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(deploymentsHarness(probe))
      )
    )
  );

test("apply adopts a legacy journal specification without reading config again", async () => {
  const kitInstance = await makeKit();
  try {
    const deploymentId = "11111111-1111-4111-8111-111111111111";
    const target = targetOf(kitInstance, deploymentId);
    await useEngines(kitInstance, (engines) =>
      Effect.scoped(
        Effect.flatMap(engines.for(deploymentId), (engine) =>
          engine.apply({ resources: deploymentResources(target) })
        )
      ).pipe(Effect.orDie)
    );
    expect(
      kitInstance.events.some((event) =>
        event.startsWith(`publish:${deploymentId}:`)
      )
    ).toBe(true);
    expect(kitInstance.gitCalls.committedFile).toBe(1);
    const firstDeployed = existsSync(
      join(kitInstance.instance, "worktrees", deploymentId)
    );
    expect(firstDeployed).toBe(true);
    kitInstance.specifications.clear();
    kitInstance.unreadableConfig = true;
    const applied = await useEngines(kitInstance, (engines) =>
      Effect.scoped(
        Effect.flatMap(engines.for(deploymentId), (engine) =>
          engine.apply({ resources: deploymentResources(target) })
        )
      ).pipe(Effect.orDie)
    );
    expect(applied.resources).toHaveLength(2);
    expect(kitInstance.specifications.get(deploymentId)).toEqual({
      kind: "static",
    });
    expect(kitInstance.gitCalls.committedFile).toBe(1);
    expect(kitInstance.gitCalls.prepareWorktree).toBe(1);
    expect(
      kitInstance.events.filter((event) =>
        event.startsWith(`publish:${deploymentId}:`)
      )
    ).toHaveLength(2);
    kitInstance.specifications.clear();
    const journal = new Database(
      join(kitInstance.instance, "resource-journals", `${deploymentId}.sqlite`)
    );
    journal
      .query("UPDATE resources SET output = ? WHERE id = 'hosted-workload'")
      .run(JSON.stringify({ specification: { kind: "unknown" } }));
    journal.close();
    const failed = await useEngines(kitInstance, (engines) =>
      Effect.scoped(
        Effect.flatMap(engines.for(deploymentId), (engine) =>
          Effect.exit(engine.apply({ resources: deploymentResources(target) }))
        )
      ).pipe(Effect.orDie)
    );
    expect(Exit.isFailure(failed)).toBe(true);
    expect(kitInstance.gitCalls.committedFile).toBe(1);
    expect(
      kitInstance.events.filter((event) => event === `reserve:${deploymentId}`)
    ).toHaveLength(2);
    expect(kitInstance.specifications.has(deploymentId)).toBe(false);
  } finally {
    kitInstance.cleanup();
  }
});

test("an interrupted first reserve replays the frozen specification without reading config again", async () => {
  const probe = await makeKit();
  const deploymentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const target = targetOf(probe, deploymentId);
  try {
    probe.slowReserve = true;
    await useEngines(probe, (engines) =>
      Effect.scoped(
        Effect.flatMap(engines.for(deploymentId), (engine) =>
          Effect.exit(
            engine
              .apply({ resources: deploymentResources(target) })
              .pipe(Effect.timeout(1000))
          )
        )
      ).pipe(Effect.asVoid, Effect.orDie)
    );
    expect(probe.events).toContain(`reserve:${deploymentId}`);
    expect(probe.events.some((event) => event.startsWith("publish:"))).toBe(
      false
    );
    expect(probe.specifications.get(deploymentId)).toEqual({ kind: "static" });
    probe.slowReserve = false;
    probe.unreadableConfig = true;
    const applied = await useEngines(probe, (engines) =>
      Effect.scoped(
        Effect.flatMap(engines.for(deploymentId), (engine) =>
          engine.apply({ resources: deploymentResources(target) })
        )
      ).pipe(Effect.orDie)
    );
    expect(applied.resources).toHaveLength(2);
    expect(probe.gitCalls.committedFile).toBe(1);
    expect(
      probe.events.filter((event) => event.startsWith("publish:"))
    ).toHaveLength(1);
  } finally {
    probe.cleanup();
  }
});

test("apply reuses a matching worktree with its untracked build output intact", async () => {
  const kitInstance = await makeKit();
  try {
    const deploymentId = "22222222-2222-4222-8222-222222222222";
    const target = targetOf(kitInstance, deploymentId);
    const apply = (engines: EnginesService) =>
      Effect.orDie(
        Effect.scoped(
          Effect.flatMap(engines.for(deploymentId), (engine) =>
            engine.apply({ resources: deploymentResources(target) })
          )
        )
      );
    const worktree = join(kitInstance.instance, "worktrees", deploymentId);
    await useEngines(kitInstance, apply);
    const sentinel = join(worktree, "node_modules", "sentinel");
    mkdirSync(join(worktree, "node_modules"), { recursive: true });
    writeFileSync(sentinel, "untracked build output");
    await useEngines(kitInstance, apply);
    expect(kitInstance.gitCalls.prepareWorktree).toBe(1);
    expect(existsSync(sentinel)).toBe(true);
  } finally {
    kitInstance.cleanup();
  }
});

test("destroy removes the workload before the workspace and converges", async () => {
  const kitInstance = await makeKit();
  try {
    const deploymentId = "33333333-3333-4333-8333-333333333333";
    const target = targetOf(kitInstance, deploymentId);
    await useEngines(kitInstance, (engines) =>
      Effect.orDie(
        Effect.scoped(
          Effect.flatMap(engines.for(deploymentId), (engine) =>
            engine.apply({ resources: deploymentResources(target) })
          )
        )
      )
    );
    await useEngines(kitInstance, (engines) =>
      Effect.orDie(
        Effect.gen(function* () {
          const git = yield* Git;
          const host = yield* DeploymentHost;
          return yield* destroyDeployment({ engines, git, host })({
            deploymentId,
            repositoryId: "1".repeat(64),
            worktree: join(kitInstance.instance, "worktrees", deploymentId),
          });
        })
      )
    );
    const withdrawIndex = kitInstance.events.indexOf(
      `withdraw:${deploymentId}`
    );
    expect(withdrawIndex).toBeGreaterThanOrEqual(0);
    const removeIndex = kitInstance.events.indexOf("git:removeWorktree");
    expect(removeIndex).toBeGreaterThan(withdrawIndex);
    expect(
      existsSync(join(kitInstance.instance, "worktrees", deploymentId))
    ).toBe(false);
    expect(
      existsSync(
        join(
          kitInstance.instance,
          "resource-journals",
          `${deploymentId}.sqlite`
        )
      )
    ).toBe(true);
  } finally {
    kitInstance.cleanup();
  }
});

test("teardown refuses the workspace while the hosted workload remains", async () => {
  const kitInstance = await makeKit();
  try {
    const deploymentId = "44444444-4444-4444-8444-444444444444";
    const target = targetOf(kitInstance, deploymentId);
    await useEngines(kitInstance, (engines) =>
      Effect.orDie(
        Effect.scoped(
          Effect.flatMap(engines.for(deploymentId), (engine) =>
            engine.apply({ resources: deploymentResources(target) })
          )
        )
      )
    );
    const refusal = await useEngines(kitInstance, (engines) =>
      Effect.scoped(
        Effect.flatMap(engines.for(deploymentId), (engine) =>
          engine.teardown([WorkspaceId])
        )
      ).pipe(
        Effect.catchTag("EngineTeardownRefusal", (refused) =>
          Effect.succeed(refused)
        ),
        Effect.orDie
      )
    );
    expect("reason" in refusal ? refusal.reason : "not-refused").toBe("in-use");
    expect(
      existsSync(join(kitInstance.instance, "worktrees", deploymentId))
    ).toBe(true);
  } finally {
    kitInstance.cleanup();
  }
});

test("closing the engine scope releases the owner token but never durable state", async () => {
  const kitInstance = await makeKit();
  try {
    const deploymentId = "55555555-5555-4555-8555-555555555555";
    const target = targetOf(kitInstance, deploymentId);
    await useEngines(kitInstance, (engines) =>
      Effect.orDie(
        Effect.scoped(
          Effect.flatMap(engines.for(deploymentId), (engine) =>
            engine.apply({ resources: deploymentResources(target) })
          )
        )
      )
    );
    const worktree = join(kitInstance.instance, "worktrees", deploymentId);
    expect(existsSync(worktree)).toBe(true);
    // The borrower scope has closed above; the durable worktree and journal
    // stay, and a fresh borrow re-opens the same journal new without loss.
    await useEngines(kitInstance, (engines) =>
      Effect.orDie(
        Effect.scoped(
          Effect.flatMap(engines.for(deploymentId), (engine) =>
            engine.apply({ resources: deploymentResources(target) })
          )
        )
      )
    );
    expect(existsSync(worktree)).toBe(true);
    expect(kitInstance.gitCalls.prepareWorktree).toBe(1);
  } finally {
    kitInstance.cleanup();
  }
});

test("a deployment without journal rows tears down through the legacy cleanup", async () => {
  const kitInstance = await makeKit();
  try {
    const deploymentId = "66666666-6666-4666-8666-666666666666";
    const worktree = join(kitInstance.instance, "worktrees", deploymentId);
    mkdirSync(worktree, { recursive: true });
    await useEngines(kitInstance, (engines) =>
      Effect.orDie(
        Effect.gen(function* () {
          const git = yield* Git;
          const host = yield* DeploymentHost;
          return yield* destroyDeployment({ engines, git, host })({
            deploymentId,
            repositoryId: "1".repeat(64),
            worktree,
          });
        })
      )
    );
    expect(kitInstance.events).toContain(`withdraw:${deploymentId}`);
    expect(kitInstance.gitCalls.removeWorktree).toBeGreaterThanOrEqual(1);
    expect(kitInstance.gitCalls.removeDeploymentRef).toBeGreaterThanOrEqual(1);
    expect(existsSync(worktree)).toBe(false);
  } finally {
    kitInstance.cleanup();
  }
});

test("two deployments' engine operations run concurrently", async () => {
  const kitInstance = await makeKit();
  kitInstance.slowPublish = true;
  try {
    const first = "77777777-7777-4777-8777-777777777777";
    const second = "88888888-8888-4888-8888-888888888888";
    const publishMarks = (deploymentId: string) =>
      kitInstance.events
        .filter((event) => event.startsWith(`publish:${deploymentId}:`))
        .map((event) => Number(event.split(":").at(-1)));
    await useEngines(kitInstance, (engines) =>
      Effect.orDie(
        Effect.forEach(
          [first, second],
          (deploymentId: string) =>
            Effect.scoped(
              Effect.flatMap(engines.for(deploymentId), (engine) =>
                engine.apply({
                  resources: deploymentResources(
                    targetOf(kitInstance, deploymentId)
                  ),
                })
              )
            ),
          { concurrency: "unbounded" }
        )
      )
    );
    const firstMarks = publishMarks(first);
    const secondMarks = publishMarks(second);
    expect(firstMarks).toHaveLength(1);
    expect(secondMarks).toHaveLength(1);
    // One journal per deployment serializes nothing across apps: the two
    // slow publishes overlap instead of queueing behind each other.
    expect(
      Math.abs((firstMarks[0] ?? 0) - (secondMarks[0] ?? 0))
    ).toBeLessThanOrEqual(400);
  } finally {
    kitInstance.cleanup();
  }
});

test("an escaping static configuration fails the hosted workload with its config stage", async () => {
  const kitInstance = await makeKit("static:\n  directory: ../..\n");
  try {
    const deploymentId = "99999999-9999-4999-8999-999999999999";
    const target = targetOf(kitInstance, deploymentId);
    const failed = await useEngines(kitInstance, (engines) =>
      Effect.orDie(
        Effect.scoped(
          Effect.flatMap(engines.for(deploymentId), (engine) =>
            Effect.exit(
              engine.apply({ resources: deploymentResources(target) })
            )
          )
        )
      ).pipe(
        Effect.map((exit) =>
          Exit.isFailure(exit)
            ? failureOr(Cause.findErrorOption(exit.cause))
            : undefined
        )
      )
    );
    expect(failed?.stage).toBe("config");
    expect(failed?.message).toContain("config:");
    expect(failed?.message).not.toContain(kitInstance.instance);
  } finally {
    kitInstance.cleanup();
  }
});

test("an engine-recorded worktree with tracked changes is reused intact", async () => {
  const kitInstance = await makeKit();
  try {
    const deploymentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const target = targetOf(kitInstance, deploymentId);
    const worktree = join(kitInstance.instance, "worktrees", deploymentId);
    const apply = (engines: EnginesService) =>
      Effect.scoped(
        Effect.flatMap(engines.for(deploymentId), (engine) =>
          engine.apply({ resources: deploymentResources(target) })
        )
      );
    await useEngines(kitInstance, (engines) => Effect.orDie(apply(engines)));
    expect(existsSync(join(worktree, ".devver.yaml"))).toBe(true);
    // A build output can touch tracked files; the recorded workspace must
    // be reused with the change intact rather than degraded or wiped.
    writeFileSync(join(worktree, ".devver.yaml"), "static: {}\n# touched\n");
    await useEngines(kitInstance, (engines) => Effect.orDie(apply(engines)));
    expect(kitInstance.gitCalls.prepareWorktree).toBe(1);
    expect(readFileSync(join(worktree, ".devver.yaml"), "utf-8")).toContain(
      "# touched"
    );
  } finally {
    kitInstance.cleanup();
  }
});

test("a legacy ready workspace with tracked changes adopts without wiping", async () => {
  const kitInstance = await makeKit();
  try {
    const deploymentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    kitInstance.statuses[deploymentId] = "ready";
    const worktree = join(kitInstance.instance, "worktrees", deploymentId);
    await useEngines(kitInstance, () =>
      Effect.orDie(
        Effect.gen(function* () {
          const git = yield* Git;
          yield* git.prepareWorktree({
            repositoryId: "1".repeat(64),
            deploymentId,
            commit: kitInstance.commit,
            source: kitInstance.checkout,
          });
        })
      )
    );
    writeFileSync(join(worktree, ".devver.yaml"), "static: {}\n# legacy\n");
    const target = targetOf(kitInstance, deploymentId);
    await useEngines(kitInstance, (engines) =>
      Effect.orDie(
        Effect.scoped(
          Effect.flatMap(engines.for(deploymentId), (engine) =>
            engine.apply({ resources: deploymentResources(target) })
          )
        )
      )
    );
    expect(kitInstance.gitCalls.prepareWorktree).toBe(1);
    expect(readFileSync(join(worktree, ".devver.yaml"), "utf-8")).toContain(
      "# legacy"
    );
  } finally {
    kitInstance.cleanup();
  }
});
