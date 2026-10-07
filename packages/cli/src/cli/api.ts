import { Effect, Layer, Option } from "effect";
import {
  ApiBaseUrl,
  type ApiClient,
  ApiClientLayer,
  AuthToken,
} from "../api/client";
import { getAccessToken } from "../auth/client";
import { readConfig } from "../config/api";
import { root } from "./root";

/** Supply one authenticated client for the entire command. */
export const withApi = <A, E, R>(effect: Effect.Effect<A, E, R | ApiClient>) =>
  Effect.gen(function* () {
    const { apiUrl } = yield* root;
    const config = yield* Effect.tryPromise(readConfig);
    if (config["local-target"]) {
      return yield* Effect.fail(
        new Error(
          "This operation is not supported on the attached local server. Run 'devver detach' to use an explicit cloud --api-url."
        )
      );
    }
    const url = Option.getOrUndefined(apiUrl);
    if (!url) {
      return yield* Effect.fail(
        new Error(
          "No CLI target attached. Run 'devver attach <url>' for a local server or provide an explicit cloud --api-url."
        )
      );
    }
    const token = yield* Effect.tryPromise(getAccessToken);
    if (!token) {
      return yield* Effect.fail(
        new Error("Not authenticated. Run 'devver auth login'.")
      );
    }
    const layer = ApiClientLayer.pipe(
      Layer.provide(Layer.succeed(AuthToken, { token })),
      Layer.provide(Layer.succeed(ApiBaseUrl, { url }))
    );
    return yield* effect.pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);
