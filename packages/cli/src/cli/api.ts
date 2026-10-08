import { Data, Effect, Layer, Option } from "effect";

import { ApiBaseUrl, ApiClientLayer, AuthToken } from "../api/client";
import type { ApiClient } from "../api/client";
import { getAccessToken } from "../auth/client";
import { readConfig } from "../config/api";
import { root } from "./root";

class ApiTargetError extends Data.TaggedError("ApiTargetError")<{
  message: string;
}> {}

/** Supply one authenticated client for the entire command. */
export const withApi = <A, E, R>(effect: Effect.Effect<A, E, R | ApiClient>) =>
  Effect.gen(function* () {
    const { apiUrl } = yield* root;
    const config = yield* Effect.tryPromise(readConfig);
    if (config["local-target"] !== undefined) {
      return yield* Effect.fail(
        new ApiTargetError({
          message:
            "This operation is not supported on the attached local server. Run 'devver detach' to use an explicit cloud --api-url.",
        })
      );
    }
    const url = Option.getOrUndefined(apiUrl);
    if (url === undefined || url === "") {
      return yield* Effect.fail(
        new ApiTargetError({
          message:
            "No CLI target attached. Run 'devver attach <url>' for a local server or provide an explicit cloud --api-url.",
        })
      );
    }
    const token = yield* Effect.tryPromise(getAccessToken);
    if (token === null || token === "") {
      return yield* Effect.fail(
        new ApiTargetError({
          message: "Not authenticated. Run 'devver auth login'.",
        })
      );
    }
    const layer = ApiClientLayer.pipe(
      Layer.provide(Layer.succeed(AuthToken, { token })),
      Layer.provide(Layer.succeed(ApiBaseUrl, { url }))
    );
    return yield* effect.pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);
