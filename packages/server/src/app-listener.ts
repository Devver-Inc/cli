/**
 * The app-facing listener.
 *
 * Deployments are published on this loopback port only, never on the control
 * port, and only to the deployment whose `<id>.localhost` hostname the request
 * carries. Each deployment's static server binds its own loopback port, which
 * stays unpublished: this listener is the single entry point in front of them,
 * so root-relative asset paths work unrewritten.
 */

import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

import { deploymentIdFromHost } from "./app-host";

const HOST = "127.0.0.1";

const isInetAddress = (
  address: string | AddressInfo | null
): address is AddressInfo => address !== null && typeof address !== "string";

/** One ephemeral loopback port, released before it is handed out. */
export async function allocatePort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, HOST, resolve);
  });
  const address = probe.address();
  try {
    if (!isInetAddress(address)) {
      throw new Error("Could not allocate a loopback port");
    }
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) => {
      probe.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }
}

/**
 * The one listener every deployment of an instance is published on.
 *
 * `preferred` is the port this instance published before: deployment URLs
 * carry it, so reusing it keeps every printed URL valid across a restart. When
 * another process holds it a new port is taken instead, and the stale URLs
 * simply stop connecting: a Host whose port is not the bound one is never
 * routed, so no request reaches a different deployment.
 */
export async function startAppListener(preferred?: number) {
  const routes = new Map<string, number>();
  let listening = 0;
  const listener = createServer((incoming, response) => {
    const deployment = deploymentIdFromHost(incoming.headers.host, listening);
    const target =
      deployment === undefined ? undefined : routes.get(deployment);
    if (target === undefined) {
      incoming.resume();
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("No deployment is published at this address");
      return;
    }
    const proxied = request(
      {
        host: HOST,
        port: target,
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers, host: `${HOST}:${target}` },
      },
      (upstream) => {
        response.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(response);
      }
    );
    proxied.once("error", () => {
      if (response.headersSent) {
        response.destroy();
      } else {
        response.writeHead(502, { "content-type": "text/plain" });
        response.end("The deployment is not responding");
      }
    });
    incoming.pipe(proxied);
  });
  const bind = async (port: number) =>
    new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        reject(error);
      };
      listener.once("error", failed);
      listener.listen(port, HOST, () => {
        listener.removeListener("error", failed);
        resolve();
      });
    });
  await (preferred === undefined
    ? bind(0)
    : bind(preferred).catch(async () => bind(0)));
  const address = listener.address();
  if (!isInetAddress(address)) {
    listener.close();
    throw new Error("The app listener did not bind a loopback port");
  }
  listening = address.port;
  return {
    port: listening,
    publish: (deploymentId: string, target: number) => {
      routes.set(deploymentId, target);
    },
    withdraw: (deploymentId: string) => {
      routes.delete(deploymentId);
    },
    close: async () => {
      routes.clear();
      listener.closeAllConnections();
      await new Promise<void>((resolve) => {
        listener.close(() => {
          resolve();
        });
      });
    },
  };
}
