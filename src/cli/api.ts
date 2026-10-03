import { Effect, Layer, Option } from "effect";
import {
  ApiBaseUrl,
  type ApiClient,
  ApiClientLayer,
  AuthToken,
} from "../api/client";
import { getAccessToken } from "../auth/client";
import { resolveApiUrl } from "../config/api";
import { root } from "./root";

/** Supply one authenticated client for the entire command. */
export const withApi = <A, E, R>(effect: Effect.Effect<A, E, R | ApiClient>) =>
  Effect.gen(function* () {
    const { apiUrl } = yield* root;
    const { token, url } = yield* Effect.tryPromise(async () => ({
      token: await getAccessToken(),
      url: await resolveApiUrl(Option.getOrUndefined(apiUrl)),
    }));
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
