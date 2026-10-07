#!/usr/bin/env node
import { createServer, type IncomingMessage } from "node:http";
import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import pkg from "../../../package.json" with { type: "json" };
import { loadInstance } from "./identity";

const HOST = "127.0.0.1";
const API_PATH = "/api/v1";
const PORT = /^(0|[1-9]\d*)$/;

function headerCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]?.toLowerCase() === name) {
      count++;
    }
  }
  return count;
}

export const serve = (name: string, port: number) =>
  Effect.gen(function* () {
    const instance = yield* Effect.tryPromise(() => loadInstance(name));
    const server = createServer((request, response) => {
      const address = server.address();
      if (!address || typeof address === "string") {
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
      if (request.url !== `${API_PATH}/identity`) {
        response.writeHead(404).end("Not found");
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" }).end("Method not allowed");
        return;
      }
      response
        .writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        })
        .end(
          JSON.stringify({
            ...instance,
            serverVersion: pkg.version,
            controlProtocolVersion: 1,
          })
        );
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      })
    );
    yield* Effect.callback<void, Error>((resume) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        resume(Effect.fail(error));
      };
      const onListening = () => {
        server.off("error", onError);
        resume(Effect.succeed(undefined));
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, HOST);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      return yield* Effect.fail(
        new Error("Server did not bind a loopback port")
      );
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
    if (!name || extra.length > 0) {
      return yield* Effect.fail(
        new Error("Usage: devver-server <name> [port]")
      );
    }
    const parsedPort = yield* Effect.try(() => parsePort(port));
    const url = yield* serve(name, parsedPort);
    console.log(url);
    yield* Effect.never;
  });
  Effect.scoped(main).pipe(NodeRuntime.runMain);
}
