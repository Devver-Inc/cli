import { create, OpenTunnelStorage, publicUrl } from "@opentunnel/client";
import type { OpenTunnelConnection } from "@opentunnel/client";
import { Effect } from "effect";
import type { SqlError } from "effect/sql";

import type { openDeploymentHost } from "./deployment-host";
import type { openDeploymentStore } from "./deployment-store";
import { openPublicIngress } from "./public-ingress";
import type { PublicRouter } from "./public-router";

const PROFILE = "devver";
const RETRY_DELAY = 30_000;

const routeName = (deploymentId: string) =>
  `d${deploymentId.replaceAll("-", "")}`;

type Store = Pick<
  Effect.Success<ReturnType<typeof openDeploymentStore>>,
  "read" | "publications"
> & {
  readonly publish: (id: string) => Effect.Effect<unknown, SqlError.SqlError>;
  readonly unpublish: (id: string) => Effect.Effect<unknown, SqlError.SqlError>;
};
type Host = Pick<Awaited<ReturnType<typeof openDeploymentHost>>, "url">;
type Ingress = Awaited<ReturnType<typeof openPublicIngress>>;
type Connection = Pick<
  OpenTunnelConnection,
  "setRoutes" | "closed" | "close"
> & {
  readonly tunnel: { readonly hostname: string };
};

interface Connector {
  readonly connect: (
    routes: Record<string, string>,
    signal: AbortSignal
  ) => Promise<Connection>;
  readonly dispose: () => Promise<void>;
}

export function managePublications(
  store: Store,
  host: Host,
  connector: Connector
): PublicRouter {
  const published = new Map<string, string | undefined>();
  const withdrawn = new Set<string>();
  let ingress: Ingress | undefined;
  let connection: Connection | undefined;
  let stopped = false;
  let pending = Promise.resolve();
  let retry: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();

  const exclusive = async <T>(action: () => Promise<T>): Promise<T> => {
    const next = pending.then(async () => {
      if (stopped) {
        throw new Error("Publishing has stopped");
      }
      return await action();
    });
    pending = next.then(
      () => undefined,
      () => undefined
    );
    return await next;
  };
  const routes = (target: string) =>
    Object.fromEntries(
      [...published.keys()].map((id) => [routeName(id), target])
    );
  const reconnect = async (target: string) => {
    if (connection === undefined) {
      const opened = await connector.connect(routes(target), controller.signal);
      connection = opened;
      void opened.closed
        .catch(() => undefined)
        .finally(() => {
          if (connection === opened) {
            connection = undefined;
          }
        });
      return opened;
    }
    const opened = connection;
    await opened.setRoutes(routes(target));
    return opened;
  };
  const revoke = (deploymentId: string) => {
    const url = published.get(deploymentId);
    if (url !== undefined) {
      ingress?.remove(new URL(url).host);
    }
    published.delete(deploymentId);
  };
  const syncRoutes = async () => {
    if (!stopped && published.size > 0 && ingress !== undefined) {
      await reconnect(ingress.target);
    } else if (connection !== undefined) {
      const previous = connection;
      await previous.close();
      if (connection === previous) {
        connection = undefined;
      }
    }
  };
  const add = async (deploymentId: string) => {
    ingress ??= await openPublicIngress();
    const gateway = ingress;
    published.set(deploymentId, published.get(deploymentId));
    try {
      const opened = await reconnect(gateway.target);
      const url = publicUrl(routeName(deploymentId), opened.tunnel.hostname);
      published.set(deploymentId, url);
      return { url, gateway };
    } catch {
      revoke(deploymentId);
      throw new Error("The tunnel did not accept the route");
    }
  };
  const restore = async () => {
    try {
      await exclusive(async () => {
        const saved = await Effect.runPromise(store.publications);
        for (const { deploymentId } of saved) {
          const deployment = await Effect.runPromise(store.read(deploymentId));
          if (deployment?.status === "ready" && !withdrawn.has(deploymentId)) {
            const { url, gateway } = await add(deploymentId);
            if (stopped) {
              throw new Error("Publishing has stopped");
            }
            gateway.add(new URL(url).host, host.url(deploymentId));
          }
        }
      });
    } catch {
      if (!stopped) {
        retry = setTimeout(() => {
          restore().catch(() => undefined);
        }, RETRY_DELAY);
      }
    }
  };
  restore().catch(() => undefined);
  return {
    publicUrl: (deploymentId) => published.get(deploymentId),
    publish: async (deploymentId: string) =>
      await exclusive(async () => {
        const deployment = await Effect.runPromise(store.read(deploymentId));
        if (deployment?.status !== "ready") {
          throw new Error("Only a ready deployment can be published");
        }
        try {
          const { url, gateway } = await add(deploymentId);
          if (stopped) {
            throw new Error("Publishing has stopped");
          }
          await Effect.runPromise(store.publish(deploymentId));
          if (stopped) {
            throw new Error("Publishing has stopped");
          }
          gateway.add(new URL(url).host, host.url(deploymentId));
          withdrawn.delete(deploymentId);
          return url;
        } catch {
          withdrawn.add(deploymentId);
          revoke(deploymentId);
          try {
            await Effect.runPromise(store.unpublish(deploymentId));
          } finally {
            await syncRoutes();
          }
          throw new Error("The deployment could not be published");
        }
      }),
    unpublish: async (deploymentId: string) => {
      await exclusive(async () => {
        withdrawn.add(deploymentId);
        revoke(deploymentId);
        try {
          await Effect.runPromise(store.unpublish(deploymentId));
        } finally {
          await syncRoutes();
        }
      });
    },
    close: async () => {
      stopped = true;
      controller.abort();
      if (retry !== undefined) {
        clearTimeout(retry);
      }
      await pending;
      try {
        await ingress?.close();
      } finally {
        try {
          await connection?.close();
        } finally {
          await connector.dispose();
        }
      }
    },
  };
}

export function openTunnelRouter(
  store: Store,
  host: Host,
  instanceDirectory: string
): PublicRouter {
  const client = create({
    api: "https://tunnels.devver.app",
    store: OpenTunnelStorage.xdg({
      env: { XDG_DATA_HOME: instanceDirectory },
    }),
  });
  return managePublications(store, host, {
    connect: async (routes, signal) =>
      await client.tunnel.connect({
        profile: PROFILE,
        routes,
        signal,
        onRouteConflict: "fail",
      }),
    dispose: async () => {
      await client.dispose();
    },
  });
}
