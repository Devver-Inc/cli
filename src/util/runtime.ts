/**
 * Singleton Effect ManagedRuntime for authenticated API calls.
 *
 * Lazily created on first use; the auth token is fetched once and baked
 * into the Layer so every subsequent `runAuthenticated(effect)` reuses it.
 * Call `disposeRuntime()` before process exit to clean up resources.
 */
import { type Effect, Layer, ManagedRuntime } from "effect";
import { type ApiClient, ApiClientLayer, AuthToken } from "../api/client";
import { getAccessToken } from "../auth/client";

type AppRuntime = ManagedRuntime.ManagedRuntime<ApiClient, never>;

let runtime: AppRuntime | null = null;

const createAuthenticatedLayer = async () => {
  const token = await getAccessToken();
  const AuthTokenLive = Layer.succeed(AuthToken, { token });
  return ApiClientLayer.pipe(Layer.provide(AuthTokenLive));
};

export const getAppRuntime = async (): Promise<AppRuntime> => {
  if (!runtime) {
    const layer = await createAuthenticatedLayer();
    runtime = ManagedRuntime.make(layer);
  }
  return runtime;
};

export const runAuthenticated = async <A, E>(
  effect: Effect.Effect<A, E, ApiClient>
): Promise<A> => {
  const rt = await getAppRuntime();
  return rt.runPromise(effect);
};

export const disposeRuntime = async () => {
  if (runtime) {
    await runtime.dispose();
    runtime = null;
  }
};
