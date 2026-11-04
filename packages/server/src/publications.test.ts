import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit, Scope } from "effect";

import { openDeploymentStore } from "./deployment-store";
import { managePublications } from "./publications";

const isTcpAddress = (
  address: AddressInfo | string | null
): address is AddressInfo => address !== null && typeof address !== "string";

async function fails(action: Promise<unknown>): Promise<boolean> {
  try {
    await action;
    return false;
  } catch {
    return true;
  }
}

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const publicHost = (id: string) =>
  `d${id.replaceAll("-", "")}.identity.example.com`;

const get = async (target: string, id: string) =>
  new Promise<number>((resolve, reject) => {
    const incoming = request(`http://${target}/`, {
      headers: { Host: publicHost(id) },
      agent: false,
    });
    incoming.on("response", (response) => {
      response.resume();
      response.on("end", () => {
        resolve(response.statusCode ?? 0);
      });
    });
    incoming.on("error", reject);
    incoming.end();
  });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "devver-publications-"));
  const scope = await Effect.runPromise(Scope.make());
  const store = await Effect.runPromise(
    openDeploymentStore(join(directory, "deployments.sqlite")).pipe(
      Effect.provideService(Scope.Scope, scope)
    )
  );
  const app = createServer((_incoming, response) => {
    response.end("preview");
  });
  await new Promise<void>((resolve) => {
    app.listen(0, "127.0.0.1", resolve);
  });
  const address = app.address();
  if (!isTcpAddress(address)) {
    throw new Error("Fixture app did not bind");
  }
  for (const deploymentId of [first, second]) {
    await Effect.runPromise(
      store.record({
        deploymentId,
        repositoryId: "a".repeat(64),
        commit: "b".repeat(40),
        parentDeploymentId: null,
        secondParentDeploymentId: null,
        worktree: directory,
      })
    );
    await Effect.runPromise(store.markReady(deploymentId));
  }
  const state = {
    failSave: false,
    failDelete: false,
    failRoutes: false,
    failClose: false,
    failConnect: false,
    stallConnect: false,
    connectStarted: false,
    failAfterCommit: false,
    duringSave: 0,
    target: "",
    connects: 0,
    closes: 0,
    disposals: 0,
  };
  const persistence = {
    ...store,
    publish: (id: string) =>
      state.failSave || state.failAfterCommit
        ? Effect.promise(async (): Promise<never> => {
            state.duringSave = await get(state.target, id);
            if (state.failAfterCommit) {
              await Effect.runPromise(store.publish(id));
            }
            throw new Error("Fixture persistence failure");
          })
        : store.publish(id),
    unpublish: (id: string) =>
      state.failDelete
        ? Effect.die(new Error("Fixture deletion failure"))
        : store.unpublish(id),
  };
  const host = {
    url: () => `http://deployment.instance.localhost:${address.port}/`,
  };
  const connector = {
    connect: async (routes: Record<string, string>, signal: AbortSignal) => {
      signal.throwIfAborted();
      state.connectStarted = true;
      if (state.stallConnect) {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("Fixture attach cancelled"));
            },
            { once: true }
          );
        });
      }
      if (state.failConnect) {
        throw new Error("Fixture relay failure");
      }
      state.connects += 1;
      state.target = Object.values(routes)[0] ?? "";
      const closed = Promise.withResolvers<undefined>();
      return {
        tunnel: { hostname: "identity.example.com" },
        closed: closed.promise,
        setRoutes: async () => {
          if (state.failRoutes) {
            throw new Error("Fixture route update failure");
          }
        },
        close: async () => {
          state.closes += 1;
          if (state.failClose) {
            throw new Error("Fixture close failure");
          }
          closed.resolve(undefined);
        },
      };
    },
    dispose: async () => {
      state.disposals += 1;
    },
  };
  let router = managePublications(persistence, host, connector);
  return {
    state,
    store,
    get router() {
      return router;
    },
    restart: async () => {
      await router.close();
      router = managePublications(persistence, host, connector);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const saved = await Effect.runPromise(store.publications);
        const current = router;
        if (
          saved.every(
            ({ deploymentId }) => current.publicUrl(deploymentId) !== undefined
          )
        ) {
          return;
        }
        await Bun.sleep(5);
      }
      throw new Error("Fixture publications were not restored");
    },
    close: async () => {
      state.failClose = false;
      await router.close().catch(() => undefined);
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await new Promise<void>((resolve) => {
        app.close(() => {
          resolve();
        });
        app.closeAllConnections();
      });
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const afterCommit of [false, true]) {
  test(`a failed publication never admits traffic and rolls back durable intent (after commit: ${afterCommit})`, async () => {
    const opened = await fixture();
    try {
      opened.state.failSave = !afterCommit;
      opened.state.failAfterCommit = afterCommit;
      expect(await fails(opened.router.publish(first))).toBe(true);
      expect(opened.state.duringSave).toBe(404);
      expect(await get(opened.state.target, first)).toBe(404);
      expect(opened.router.publicUrl(first)).toBeUndefined();
      expect(await Effect.runPromise(opened.store.publications)).toEqual([]);
    } finally {
      await opened.close();
    }
  });
}

test("unpublish denies access even if deleting durable intent fails", async () => {
  const opened = await fixture();
  try {
    await opened.router.publish(first);
    await opened.router.publish(second);
    opened.state.failDelete = true;
    expect(await fails(opened.router.unpublish(first))).toBe(true);
    expect(await get(opened.state.target, first)).toBe(404);
    expect(await get(opened.state.target, second)).toBe(200);
    expect(opened.router.publicUrl(first)).toBeUndefined();
    opened.state.failDelete = false;
    await opened.router.unpublish(first);
    expect(await Effect.runPromise(opened.store.publications)).toEqual([
      { deploymentId: second },
    ]);
  } finally {
    await opened.close();
  }
});

test("a relay update failure cannot keep an unpublished app accessible", async () => {
  const opened = await fixture();
  try {
    await opened.router.publish(first);
    await opened.router.publish(second);
    opened.state.failRoutes = true;
    expect(await fails(opened.router.unpublish(first))).toBe(true);
    expect(await get(opened.state.target, first)).toBe(404);
    expect(await get(opened.state.target, second)).toBe(200);
    expect(await Effect.runPromise(opened.store.publications)).toEqual([
      { deploymentId: second },
    ]);
    opened.state.failRoutes = false;
    await opened.router.unpublish(first);
  } finally {
    await opened.close();
  }
});

test("one connection serves multiple publications and restores only saved routes", async () => {
  const opened = await fixture();
  try {
    const [url] = await Promise.all([
      opened.router.publish(first),
      opened.router.publish(second),
    ]);
    expect(url).toBeDefined();
    expect(opened.state.connects).toBe(1);
    await opened.router.unpublish(second);
    await opened.restart();
    expect(opened.router.publicUrl(first)).toBe(url);
    expect(opened.router.publicUrl(second)).toBeUndefined();
    expect(await get(opened.state.target, first)).toBe(200);
    expect(await get(opened.state.target, second)).toBe(404);
  } finally {
    await opened.close();
  }
});

test("a refused relay attach records no publication", async () => {
  const opened = await fixture();
  try {
    opened.state.failConnect = true;
    expect(await fails(opened.router.publish(first))).toBe(true);
    expect(opened.router.publicUrl(first)).toBeUndefined();
    expect(await Effect.runPromise(opened.store.publications)).toEqual([]);
  } finally {
    await opened.close();
  }
});

test("shutdown cancels an in-flight attach without recording or admitting the route", async () => {
  const opened = await fixture();
  try {
    opened.state.stallConnect = true;
    const failed = fails(opened.router.publish(first));
    for (
      let attempt = 0;
      attempt < 100 && !opened.state.connectStarted;
      attempt += 1
    ) {
      await Bun.sleep(5);
    }
    expect(opened.state.connectStarted).toBe(true);
    await opened.router.close();
    expect(await failed).toBe(true);
    expect(opened.router.publicUrl(first)).toBeUndefined();
    expect(await Effect.runPromise(opened.store.publications)).toEqual([]);
    expect(opened.state.disposals).toBe(1);
  } finally {
    await opened.close();
  }
});

test("shutdown closes the ingress and disposes the connector even if closing the relay fails", async () => {
  const opened = await fixture();
  try {
    await opened.router.publish(first);
    opened.state.failClose = true;
    expect(await fails(opened.router.close())).toBe(true);
    expect(opened.state.disposals).toBe(1);
    expect(await fails(get(opened.state.target, first))).toBe(true);
  } finally {
    await opened.close();
  }
});
