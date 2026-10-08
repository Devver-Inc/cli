#!/usr/bin/env node
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Data, Effect, Layer } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { API_PATH, api } from "./api";
import { instanceHandlers } from "./handlers";
import { loadInstance } from "./identity";

const HOST = "127.0.0.1";
const PORT = /^(?<zero>0|[1-9]\d*)$/u;

class ServerStartupError extends Data.TaggedError("ServerStartupError")<{
  message: string;
}> {}

const isNodeRequest = (
  source: HttpServerRequest.HttpServerRequest["source"]
): source is IncomingMessage =>
  "rawHeaders" in source && Array.isArray(source.rawHeaders);

function headerCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      count += 1;
    }
  }
  return count;
}

function isSameOrigin(request: IncomingMessage, origin: string): boolean {
  const originHeaders = headerCount(request, "origin");
  const fetchSite = request.headers["sec-fetch-site"];
  return (
    headerCount(request, "host") === 1 &&
    request.headers.host === new URL(origin).host &&
    (originHeaders === 0 ||
      (originHeaders === 1 && request.headers.origin === origin)) &&
    (fetchSite === undefined ||
      fetchSite === "same-origin" ||
      fetchSite === "none")
  );
}

const serveOnListener = (name: string) =>
  Effect.gen(function* () {
    const instance = yield* Effect.tryPromise(async () => loadInstance(name));
    const { address } = yield* HttpServer.HttpServer;
    if (address._tag === "UnixPathAddress") {
      return yield* new ServerStartupError({
        message: "Server did not bind a loopback port",
      });
    }
    const origin = `http://${HOST}:${address.port}`;

    const requestPolicy = HttpRouter.middleware(
      (next) =>
        Effect.gen(function* () {
          const { source } = yield* HttpServerRequest.HttpServerRequest;
          if (!(isNodeRequest(source) && isSameOrigin(source, origin))) {
            return HttpServerResponse.text("Forbidden", { status: 403 });
          }
          // Effect's router ignores query strings and returns 404 for wrong methods.
          if (
            source.url !== undefined &&
            source.url.startsWith(`${API_PATH}/identity`) &&
            source.url !== `${API_PATH}/identity`
          ) {
            return HttpServerResponse.text("Not found", { status: 404 });
          }
          if (
            source.url === `${API_PATH}/identity` &&
            source.method !== "GET"
          ) {
            return HttpServerResponse.text("Method not allowed", {
              status: 405,
              headers: { Allow: "GET" },
            });
          }
          return yield* next;
        }),
      { global: true }
    );
    const handler = yield* HttpRouter.toHttpEffect(
      Layer.mergeAll(
        HttpApiBuilder.layer(api).pipe(
          Layer.provide(instanceHandlers(instance))
        ),
        requestPolicy
      )
    );
    yield* HttpServer.serveEffect(handler);

    return `${origin}${API_PATH}`;
  });

// Build in the caller's scope so returning the URL does not close the listener.
export const serve = (name: string, port: number) =>
  Effect.gen(function* () {
    const listener = yield* Layer.build(
      NodeHttpServer.layer(() => createServer(), { host: HOST, port })
    );
    return yield* serveOnListener(name).pipe(Effect.provide(listener));
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
