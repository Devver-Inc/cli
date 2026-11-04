import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { connect, createServer } from "node:net";

import { openPublicIngress } from "../../packages/server/public-ingress";

const isTcpAddress = (
  address: AddressInfo | string | null
): address is AddressInfo => address !== null && typeof address !== "string";

const HOST_HEADER = /\r\nhost: (?<host>.+)\r\n/iu;
const KEY_HEADER = /\r\nsec-websocket-key: (?<key>.+)\r\n/iu;
const APP_HOST = /X-App-Host: (?<host>.+)\r\n/iu;

const backendClosed = Promise.withResolvers<undefined>();
const timeout = setTimeout(() => {
  process.stderr.write("Upgrade revocation timed out\n");
  process.exit(1);
}, 3000);
timeout.unref();

const app = createServer((socket) => {
  socket.on("close", () => {
    backendClosed.resolve(undefined);
  });
  socket.once("data", (buffer: Buffer) => {
    const text = buffer.toString();
    const host = HOST_HEADER.exec(text)?.groups?.host;
    const key = KEY_HEADER.exec(text)?.groups?.key;
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nX-App-Host: ${host}\r\n\r\n`
    );
  });
});

const upgrade = async (port: number, host: string) =>
  new Promise<{ headers: string; closed: Promise<void> }>((resolve, reject) => {
    const closed = Promise.withResolvers<undefined>();
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      if (text.includes("\r\n\r\n")) {
        resolve({ headers: text, closed: closed.promise });
      }
    });
    socket.on("close", () => {
      closed.resolve(undefined);
      resolve({
        headers: Buffer.concat(chunks).toString(),
        closed: closed.promise,
      });
    });
    socket.on("connect", () => {
      socket.write(
        `GET /chat HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
  });

const main = async () => {
  await new Promise<void>((resolve) => {
    app.listen(0, "127.0.0.1", resolve);
  });
  const address = app.address();
  if (!isTcpAddress(address)) {
    throw new Error("mock app did not bind");
  }
  const ingress = await openPublicIngress();
  ingress.add(
    "preview.identity.tunnels.devver.app",
    `http://deployment.instance.localhost:${address.port}/`
  );
  const port = Number(ingress.target.split(":")[1]);
  const matched = await upgrade(port, "preview.identity.tunnels.devver.app");
  const wrongHost = await upgrade(port, "other.identity.tunnels.devver.app");
  ingress.remove("preview.identity.tunnels.devver.app");
  await Promise.all([matched.closed, backendClosed.promise]);
  await ingress.close();
  await new Promise<void>((resolve) => {
    app.close(() => {
      resolve();
    });
  });
  process.stdout.write(
    `${JSON.stringify({
      bunGlobal: "Bun" in globalThis,
      switched: matched.headers.includes("101 Switching Protocols"),
      forwardedHost: APP_HOST.exec(matched.headers)?.groups?.host ?? null,
      wrongHostRejected:
        wrongHost.headers.includes("404") || wrongHost.headers.length === 0,
      revoked: true,
    })}\n`
  );
};

try {
  await main();
  process.exit(0);
} catch {
  process.stderr.write("Upgrade proxy verification failed\n");
  process.exit(1);
}
