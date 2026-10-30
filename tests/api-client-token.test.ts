import { expect, test } from "bun:test";

import { Effect, Layer, Schema } from "effect";

import {
  ApiBaseUrl,
  ApiClient,
  ApiClientLayer,
  AuthToken,
} from "../packages/cli/src/api/client";

test("a scoped API client uses the current token after an organization switch", async () => {
  const headers: (string | null)[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      headers.push(request.headers.get("authorization"));
      return Response.json("ok");
    },
  });
  try {
    let token = "first-token";
    const layer = ApiClientLayer.pipe(
      Layer.provide(Layer.succeed(AuthToken, { token: () => token })),
      Layer.provide(
        Layer.succeed(ApiBaseUrl, { url: `http://localhost:${server.port}` })
      )
    );
    const program = Effect.gen(function* () {
      const api = yield* ApiClient;
      yield* api.get("/first", Schema.String);
      token = "second-token";
      yield* api.get("/second", Schema.String);
    });
    // @effect-diagnostics-next-line strictEffectProvide:off -- This test owns the application scope.
    await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped));
    expect(headers).toEqual(["Bearer first-token", "Bearer second-token"]);
  } finally {
    await server.stop();
  }
});
