import { Data, Effect, Layer, Option } from "effect";

import { ApiBaseUrl, ApiClientLayer, AuthToken } from "../api/client";
import type { ApiClient } from "../api/client";
import { getAccessToken } from "../auth/client";
import { CLOUD_API_URL, readConfig } from "../config/api";
import type { LocalTargetSchema } from "../config/api";
import { root } from "./root";

class ApiTargetError extends Data.TaggedError("ApiTargetError")<{
  message: string;
}> {}

export const withLocalApi = <A, E, R>(
  target: typeof LocalTargetSchema.Type,
  effect: Effect.Effect<A, E, R | ApiClient>
) => {
  const layer = ApiClientLayer.pipe(
    Layer.provide(Layer.succeed(AuthToken, { token: null })),
    Layer.provide(Layer.succeed(ApiBaseUrl, { url: target.url }))
  );
  // @effect-diagnostics-next-line strictEffectProvide:off
  return effect.pipe(Effect.provide(layer), Effect.scoped);
};

export const withApiAt = <A, E, R>(
  apiUrl: Option.Option<string>,
  effect: Effect.Effect<A, E, R | ApiClient>
) =>
  Effect.gen(function* () {
    const config = yield* Effect.tryPromise(readConfig);
    if (config["local-target"] !== undefined) {
      return yield* new ApiTargetError({
        message:
          "This operation is not supported on the attached local server. Run 'devver cloud' to select the official cloud API.",
      });
    }
    const explicitUrl = Option.getOrUndefined(apiUrl);
    const url =
      explicitUrl ??
      (config["cloud-target"] === true ? CLOUD_API_URL : undefined);
    if (url === undefined || url === "") {
      return yield* new ApiTargetError({
        message:
          "No CLI target selected. Run 'devver cloud', attach a local server, or provide --api-url for this command.",
      });
    }
    const token = yield* Effect.tryPromise(getAccessToken);
    if (token === null || token === "") {
      return yield* new ApiTargetError({
        message: "Not authenticated. Run 'devver auth login'.",
      });
    }
    const layer = ApiClientLayer.pipe(
      Layer.provide(Layer.succeed(AuthToken, { token })),
      Layer.provide(Layer.succeed(ApiBaseUrl, { url }))
    );
    // @effect-diagnostics-next-line strictEffectProvide:off
    return yield* effect.pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);

export const withApi = <A, E, R>(effect: Effect.Effect<A, E, R | ApiClient>) =>
  Effect.gen(function* () {
    const { apiUrl } = yield* root;
    return yield* withApiAt(apiUrl, effect);
  });
