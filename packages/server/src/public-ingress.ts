import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import type { Duplex } from "node:stream";

const isTcpAddress = (
  address: AddressInfo | string | null
): address is AddressInfo => address !== null && typeof address !== "string";

function singleHost(request: IncomingMessage): string | undefined {
  let value: string | undefined;
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "host") {
      value = request.rawHeaders[index + 1];
      count += 1;
    }
  }
  return count === 1 ? value : undefined;
}

function safePath(url: string | undefined): boolean {
  return url?.startsWith("/") === true && !url.startsWith("//");
}

interface App {
  readonly url: URL;
  readonly disconnect: Set<() => void>;
}

export async function openPublicIngress() {
  const apps = new Map<string, App>();
  const sockets = new Set<Duplex>();
  const appFor = (request: IncomingMessage): App | undefined => {
    const host = singleHost(request);
    return host !== undefined && safePath(request.url)
      ? apps.get(host)
      : undefined;
  };
  const server = createServer((incoming, response: ServerResponse) => {
    const app = appFor(incoming);
    if (app === undefined) {
      response.writeHead(404).end();
      return;
    }
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port: app.url.port,
      path: incoming.url,
      method: incoming.method,
      headers: { ...incoming.headers, host: app.url.host },
    });
    const disconnect = () => {
      upstream.destroy();
      response.destroy();
    };
    app.disconnect.add(disconnect);
    response.once("close", () => {
      app.disconnect.delete(disconnect);
      upstream.destroy();
    });
    upstream.on("response", (result) => {
      response.writeHead(result.statusCode ?? 502, result.headers);
      result.pipe(response);
    });
    upstream.on("error", () => {
      if (response.headersSent) {
        response.destroy();
      } else {
        response.writeHead(502).end();
      }
    });
    incoming.pipe(upstream);
  });
  server.on("upgrade", (incoming, socket, head) => {
    const app = appFor(incoming);
    if (app === undefined) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const target = connect(Number(app.url.port), "127.0.0.1");
    const disconnect = () => {
      socket.destroy();
      target.destroy();
    };
    app.disconnect.add(disconnect);
    sockets.add(socket);
    socket.on("error", disconnect);
    socket.on("close", () => {
      sockets.delete(socket);
      app.disconnect.delete(disconnect);
      target.destroy();
    });
    let headers = "";
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
      const name = incoming.rawHeaders[index] ?? "";
      const value =
        name.toLowerCase() === "host"
          ? app.url.host
          : incoming.rawHeaders[index + 1];
      headers += `${name}: ${value}\r\n`;
    }
    sockets.add(target);
    target.on("close", () => {
      sockets.delete(target);
      app.disconnect.delete(disconnect);
      socket.destroy();
    });
    target.on("error", disconnect);
    target.on("connect", () => {
      target.write(
        `${incoming.method} ${incoming.url} HTTP/1.1\r\n${headers}\r\n`
      );
      if (head.length > 0) {
        target.write(head);
      }
      target.pipe(socket);
      socket.pipe(target);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!isTcpAddress(address)) {
    server.close();
    throw new Error("Public app ingress did not bind a loopback port");
  }
  return {
    target: `127.0.0.1:${address.port}`,
    add: (publicHost: string, appUrl: string) => {
      apps.set(publicHost, {
        url: new URL(appUrl),
        disconnect: apps.get(publicHost)?.disconnect ?? new Set(),
      });
    },
    remove: (publicHost: string) => {
      const app = apps.get(publicHost);
      apps.delete(publicHost);
      for (const disconnect of app?.disconnect ?? []) {
        disconnect();
      }
    },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }
          reject(error);
        });
        server.closeAllConnections();
      });
    },
  };
}
