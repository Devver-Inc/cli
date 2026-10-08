#!/usr/bin/env node
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { NodeRuntime } from "@effect/platform-node";
import { Data, Effect } from "effect";

import { loadInstance } from "./identity";
import { matchRoute } from "./routes";

const HOST = "127.0.0.1";
const API_PATH = "/api/v1";
const PORT = /^(?<zero>0|[1-9]\d*)$/u;

class ServerStartupError extends Data.TaggedError("ServerStartupError")<{
  message: string;
}> {}

/** A bound loopback socket, as opposed to a pipe name or an unbound server. */
const isTcpAddress = (
  address: ReturnType<ReturnType<typeof createServer>["address"]>
): address is AddressInfo => address !== null && typeof address !== "string";

function headerCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]?.toLowerCase() === name) {
      count += 1;
    }
  }
  return count;
}

export const serve = (name: string, port: number) =>
  Effect.gen(function* () {
    const instance = yield* Effect.tryPromise(async () => loadInstance(name));
    const server = createServer((request, response) => {
      const address = server.address();
      if (!isTcpAddress(address)) {
        response.writeHead(503).end();
        return;
      }
      const origin = `http://${HOST}:${address.port}`;
      if (
        headerCount(request, "host") !== 1 ||
        request.headers.host !== `${HOST}:${address.port}` ||
        (headerCount(request, "origin") > 0 &&
          (headerCount(request, "origin") !== 1 ||
            request.headers.origin !== origin)) ||
        (request.headers["sec-fetch-site"] !== undefined &&
          request.headers["sec-fetch-site"] !== "same-origin" &&
          request.headers["sec-fetch-site"] !== "none")
      ) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      // The prefix is required and the path below it must match exactly, so a
      // query string, a trailing slash or an unprefixed path is not a route.
      const url = request.url ?? "";
      const match = url.startsWith(API_PATH)
        ? matchRoute(url.slice(API_PATH.length), request.method)
        : ({ outcome: "unknown-path" } as const);
      if (match.outcome === "unknown-path") {
        response.writeHead(404).end("Not found");
        return;
      }
      if (match.outcome === "wrong-method") {
        response
          .writeHead(405, { Allow: match.allow })
          .end("Method not allowed");
        return;
      }
      response
        .writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        })
        .end(JSON.stringify(match.route.handler({ instance })));
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      })
    );
    yield* Effect.callback<null, Error>((resume) => {
      function onListening() {
        // oxlint-disable-next-line no-use-before-define -- Paired listener removal requires referring to the error handler declared below.
        server.off("error", onError);
        resume(Effect.succeed(null));
      }
      function onError(error: Error) {
        server.off("listening", onListening);
        resume(Effect.fail(error));
      }
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, HOST);
    });
    const address = server.address();
    if (!isTcpAddress(address)) {
      return yield* new ServerStartupError({
        message: "Server did not bind a loopback port",
      });
    }
    return `http://${HOST}:${address.port}${API_PATH}`;
  });

function parsePort(input: string | undefined) {
  if (input === undefined) {
    return 0;
  }
  if (!PORT.test(input)) {
    throw new Error("Invalid port");
  }
  const port = Number(input);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("Invalid port");
  }
  return port;
}

if (import.meta.main) {
  const [name, port, ...extra] = process.argv.slice(2);
  const main = Effect.gen(function* () {
    if (name === undefined || name === "" || extra.length > 0) {
      return yield* new ServerStartupError({
        message: "Usage: devver-server <name> [port]",
      });
    }
    const parsedPort = yield* Effect.try(() => parsePort(port));
    const url = yield* serve(name, parsedPort);
    console.log(url);
    return yield* Effect.never;
  });
  NodeRuntime.runMain(Effect.scoped(main));
}
