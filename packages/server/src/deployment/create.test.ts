import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node";
import { Effect, Exit, Fiber, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import type { WorkflowEngine } from "effect/workflow/WorkflowEngine";

import type { DeployFailure } from "../api";
import { DeploymentHost } from "../deployment-host";
import type { HostService } from "../deployment-host";
import { DeploymentStore } from "../deployment-store";
import type { StoreService } from "../deployment-store";
import { runProcess } from "../exec";
import { Git, GitFailure } from "../git-source";
import type { GitService } from "../git-source";
import { InstanceDirectory } from "../instance-directory";
import type { StaticDeploymentTarget, DeploymentCreateService } from "./create";
import {
  DeploymentCreate,
  deploymentCreateLayer,
  deploymentGuardsLayer,
  deploymentWorkflowLayer,
} from "./create";
import { HostFailure } from "./failures";
import { enginesLayer } from "./resources";

const childProcesses = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(NodePath.layer)
);

const isLoopbackBinding = (
  bound: AddressInfo | string | null
): bound is AddressInfo => bound !== null && typeof bound === "object";

const answerServer = async () => {
  const http = createServer((_request, response) => {
    response.statusCode = 200;
    response.end("published");
  });
  await new Promise<void>((resolve) => {
    http.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const bound = http.address();
  if (!isLoopbackBinding(bound)) {
    throw new Error("the answer server did not bind a loopback port");
  }
  return { http, answerPort: bound.port };
};

const sleep = async (ms: number) => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const waitFor = async (
  events: readonly string[],
  started: (event: string) => boolean
) => {
  for (let waited = 0; waited < 8000 && !events.some(started); waited += 20) {
    await sleep(20);
  }
};

const gitFailure = (message: string) => new GitFailure({ message });
const unusedGit = () => Effect.fail(gitFailure("unused by this run"));

type PrepareMode = "fast" | "slow-abortable" | "slow-stuck";

interface HarnessOptions {
  readonly prepareMode: PrepareMode;
  readonly slowReserve: boolean;
  readonly committed: string | null;
  readonly answerPort: number;
}

const EVENTS_TIMEOUT_MS = 60_000;

// A real workflow runtime, real resource engine and the real deployment
// providers over fake Git, host and store capabilities, recording live calls
// so a run's execution and termination stay observable.
const harness = (options: HarnessOptions) => {
  const instance = mkdtempSync(join(tmpdir(), "devver-create-"));
  const events: string[] = [];
  const deploymentPort = 45_678;
  const gitService: GitService = {
    verifiedSource: unusedGit,
    firstParentDeployment: unusedGit,
    mergeCommits: unusedGit,
    prepareWorktree: ({ deploymentId }) => {
      const worktree = join(instance, "worktrees", deploymentId);
      if (options.prepareMode === "slow-abortable") {
        return Effect.andThen(
          Effect.sync(() => {
            events.push("prepare");
          }),
          runProcess("sleep", ["4"], {
            timeoutMs: EVENTS_TIMEOUT_MS,
            maxBufferBytes: 1024,
          }).pipe(
            Effect.map(() => {
              events.push("prepare-aborted-error");
              return worktree;
            }),
            Effect.mapError(() =>
              gitFailure("the probed prepare subprocess was killed")
            )
          )
        );
      }
      if (options.prepareMode === "slow-stuck") {
        return Effect.andThen(
          Effect.sync(() => {
            events.push("prepare");
          }),
          Effect.uninterruptible(
            runProcess("sleep", ["0.6"], {
              timeoutMs: EVENTS_TIMEOUT_MS,
              maxBufferBytes: 1024,
            }).pipe(
              Effect.map(() => {
                events.push("prepare-done");
                return worktree;
              }),
              Effect.mapError(() => gitFailure("the probed prepare failed"))
            )
          )
        );
      }
      return Effect.sync(() => {
        events.push("prepare");
        mkdirSync(worktree, { recursive: true });
        events.push("prepare-done");
        return worktree;
      });
    },
    inspectWorktree: () => Effect.succeed({ present: false }),
    subjectsOf: () => Effect.succeed(new Map()),
    committedFile: () =>
      Effect.sync(() => {
        events.push("spec");
        return options.committed;
      }),
    removeWorktree: () => Effect.void,
    removeDeploymentRef: () => Effect.void,
  };
  const hostService: HostService = {
    reserve: (deploymentId) => {
      const step = options.slowReserve
        ? Effect.sleep("4 seconds").pipe(
            Effect.mapError(
              () =>
                new HostFailure({
                  message: "the probed reserve step was killed",
                })
            )
          )
        : Effect.void;
      return Effect.andThen(
        Effect.sync(() => {
          events.push(`reserve:${deploymentId}`);
        }),
        Effect.as(step, {
          port: deploymentPort,
          directory: join(instance, "slot", deploymentId),
        })
      );
    },
    publish: (deploymentId, spec) =>
      Effect.sync(() => {
        events.push(`publish:${deploymentId}:${spec.port}`);
      }),
    withdraw: () =>
      Effect.sync(() => {
        events.push("withdraw");
      }),
    url: (deploymentId) =>
      `http://127.0.0.1:${options.answerPort}/${deploymentId}/`,
    proxyPort: options.answerPort,
  };
  const storeService: StoreService = {
    record: () => Effect.void,
    rename: () => Effect.succeed(false),
    markReady: (deploymentId) =>
      Effect.sync(() => {
        events.push(`ready:${deploymentId}`);
      }),
    markFailed: () => Effect.void,
    markDegraded: () => Effect.void,
    // oxlint-disable-next-line effecttsgo/effect-succeed-with-void -- the harness store returns no record; the undefined value is the record, not a void effect.
    read: () => Effect.succeed(undefined),
    list: Effect.succeed({ deployments: [], unreadable: 0 }),
    // oxlint-disable-next-line effecttsgo/effect-succeed-with-void -- the unsaved app port is a genuinely undefined value, not a void effect.
    appPort: Effect.succeed<number | undefined>(undefined),
    setAppPort: () => Effect.void,
  };
  const fakes = Layer.mergeAll(
    Layer.effect(Git, Effect.succeed(gitService)),
    Layer.effect(DeploymentHost, Effect.succeed(hostService)),
    Layer.effect(DeploymentStore, Effect.succeed(storeService))
  );
  const directory = Layer.succeed(InstanceDirectory, {
    directory: instance,
    worktrees: join(instance, "worktrees"),
    repositories: join(instance, "repositories"),
  });
  const transports = Layer.mergeAll(FetchHttpClient.layer, childProcesses);
  const engines = enginesLayer.pipe(
    Layer.provide(fakes),
    Layer.provide(directory),
    Layer.provide(transports)
  );
  const workflow = deploymentWorkflowLayer.pipe(
    Layer.provide(deploymentGuardsLayer),
    Layer.provide(engines),
    Layer.provide(fakes),
    Layer.provide(directory),
    Layer.provide(transports)
  );
  return {
    events,
    instance,
    context: Layer.mergeAll(
      deploymentCreateLayer,
      workflow,
      engines,
      fakes,
      directory,
      transports
    ).pipe(Layer.orDie),
  };
};

const target = (deploymentId = randomUUID()): StaticDeploymentTarget => ({
  deploymentId,
  repositoryId: "1".repeat(64),
  commit: "a".repeat(40),
  originKind: "repository",
  originPath: "/devver/source",
});

const withRunner = async (
  probe: ReturnType<typeof harness>,
  exercise: (
    runner: DeploymentCreateService
  ) => Effect.Effect<void, DeployFailure, WorkflowEngine>
) => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.orDie(
        Effect.flatMap(DeploymentCreate, (runner) => exercise(runner))
      ).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(probe.context)
      )
    )
  );
};

const cancelledDuring = async (
  options: Omit<HarnessOptions, "answerPort">,
  reached: (event: string) => boolean
) => {
  const probe = harness({ ...options, answerPort: 45_679 });
  try {
    await withRunner(probe, (runner) =>
      Effect.gen(function* () {
        const created = target();
        const fiber = yield* Effect.forkChild(runner.create(created));
        yield* Effect.promise(async () => waitFor(probe.events, reached));
        if (!probe.events.some(reached)) {
          yield* Effect.log("the probe never reached its step");
        }
        const started = yield* Effect.sync(() => Date.now());
        yield* runner.interrupt(created);
        const elapsed = yield* Effect.sync(() => Date.now() - started);
        yield* Fiber.await(fiber);
        yield* Effect.sleep(250);
        expect(elapsed).toBeLessThan(3000);
        expect(probe.events).not.toContain(
          `publish:${created.deploymentId}:45678`
        );
        expect(probe.events).not.toContain(`ready:${created.deploymentId}`);
        expect(
          probe.events.filter(
            (event) =>
              event === "withdraw" ||
              event.startsWith("ready:") ||
              event.includes("publish")
          )
        ).toEqual([]);
      })
    );
  } finally {
    rmSync(probe.instance, { recursive: true, force: true });
  }
};

test("a create cancelled during its live git prepare never publishes or marks ready", async () => {
  await cancelledDuring(
    { prepareMode: "slow-abortable", slowReserve: false, committed: null },
    (event) => event === "prepare"
  );
});

test("a create cancelled during a slow live reserve never publishes or marks ready", async () => {
  await cancelledDuring(
    { prepareMode: "fast", slowReserve: true, committed: null },
    (event) => event.startsWith("reserve:")
  );
});

test("a create cancelled while an abort-immune prepare runs waits for it", async () => {
  const probe = harness({
    prepareMode: "slow-stuck",
    slowReserve: false,
    committed: null,
    answerPort: 45_679,
  });
  try {
    await withRunner(probe, (runner) =>
      Effect.gen(function* () {
        const created = target();
        const fiber = yield* Effect.forkChild(runner.create(created));
        yield* Effect.promise(async () =>
          waitFor(probe.events, (event) => event === "prepare")
        );
        const started = yield* Effect.sync(() => Date.now());
        yield* runner.interrupt(created);
        const elapsed = yield* Effect.sync(() => Date.now() - started);
        yield* Fiber.await(fiber);
        yield* Effect.sleep(50);
        expect(elapsed).toBeGreaterThanOrEqual(300);
        expect(elapsed).toBeLessThan(3000);
        expect(probe.events).toContain("prepare-done");
        expect(probe.events).not.toContain(
          `publish:${created.deploymentId}:45678`
        );
        expect(probe.events).not.toContain(`ready:${created.deploymentId}`);
      })
    );
  } finally {
    rmSync(probe.instance, { recursive: true, force: true });
  }
});

test("a create cancelled right after its request never publishes or marks ready", async () => {
  const probe = harness({
    prepareMode: "slow-abortable",
    slowReserve: false,
    committed: null,
    answerPort: 45_679,
  });
  try {
    await withRunner(probe, (runner) =>
      Effect.gen(function* () {
        const created = target();
        const fiber = yield* Effect.forkChild(runner.create(created));
        const started = yield* Effect.sync(() => Date.now());
        yield* runner.interrupt(created);
        const elapsed = yield* Effect.sync(() => Date.now() - started);
        yield* Fiber.await(fiber);
        yield* Effect.sleep(500);
        expect(elapsed).toBeLessThan(3000);
        expect(probe.events).not.toContain(
          `publish:${created.deploymentId}:45678`
        );
        expect(probe.events).not.toContain(`ready:${created.deploymentId}`);
        const observed = [...probe.events];
        yield* Effect.sleep(400);
        expect(probe.events).toEqual(observed);
      })
    );
  } finally {
    rmSync(probe.instance, { recursive: true, force: true });
  }
});

test("an uncancelled create publishes, marks ready and returns its URL", async () => {
  const { http, answerPort } = await answerServer();
  const probe = harness({
    prepareMode: "fast",
    slowReserve: false,
    committed: "process:\n  install: git --version\n  run: sleep 5\n",
    answerPort,
  });
  try {
    await withRunner(probe, (runner) =>
      Effect.gen(function* () {
        const created = target();
        const finished = yield* runner.create(created);
        expect(finished.url).toContain(created.deploymentId);
        yield* Effect.promise(async () =>
          waitFor(
            probe.events,
            (event) => event === `ready:${created.deploymentId}`
          )
        );
        expect(probe.events).toContain(`publish:${created.deploymentId}:45678`);
      })
    );
  } finally {
    http.close();
    rmSync(probe.instance, { recursive: true, force: true });
  }
});

test("interrupting an already failed create returns without waiting on a guard", async () => {
  const probe = harness({
    prepareMode: "fast",
    slowReserve: false,
    committed: ":{ not deployable configuration",
    answerPort: 45_679,
  });
  try {
    await withRunner(probe, (runner) =>
      Effect.gen(function* () {
        const created = target();
        const exit = yield* Effect.exit(runner.create(created));
        expect(Exit.isFailure(exit) ? exit.cause : undefined).toBeDefined();
        // The terminal run has no live body: interrupting must not wait on
        // a guard that no run will ever complete.
        const started = yield* Effect.sync(() => Date.now());
        yield* runner.interrupt(created);
        const elapsed = yield* Effect.sync(() => Date.now() - started);
        expect(elapsed).toBeLessThan(3000);
      })
    );
  } finally {
    rmSync(probe.instance, { recursive: true, force: true });
  }
});
