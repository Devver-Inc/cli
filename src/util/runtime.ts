/**
 * Singleton Effect ManagedRuntime for authenticated API calls.
 *
 * Lazily created on first use; the auth token and API base URL are
 * resolved once and baked into the Layer so every subsequent
 * `runAuthenticated(effect)` reuses them.
 * Call `disposeRuntime()` before process exit to clean up resources.
 */
import { type Effect, Layer, ManagedRuntime } from "effect";
import {
  ApiBaseUrl,
  type ApiClient,
  ApiClientLayer,
  AuthToken,
} from "../api/client";
import { getAccessToken } from "../auth/client";
import { resolveApiUrl } from "../config/api";

type AppRuntime = ManagedRuntime.ManagedRuntime<ApiClient, never>;

let runtime: AppRuntime | null = null;
let cachedApiUrl: string | undefined;

let explicitApiUrl: string | undefined;

export function setExplicitApiUrl(url: string | undefined): void {
  explicitApiUrl = url;
}

export async function hasApiUrlChanged(): Promise<boolean> {
  const newUrl = await resolveApiUrl(explicitApiUrl);
  return cachedApiUrl !== undefined && cachedApiUrl !== newUrl;
}

const createAuthenticatedLayer = async () => {
  const [token, apiUrl] = await Promise.all([
    getAccessToken(),
    resolveApiUrl(explicitApiUrl),
  ]);
  cachedApiUrl = apiUrl;
  const AuthTokenLive = Layer.succeed(AuthToken, { token });
  const ApiBaseUrlLive = Layer.succeed(ApiBaseUrl, { url: apiUrl });
  return ApiClientLayer.pipe(
    Layer.provide(AuthTokenLive),
    Layer.provide(ApiBaseUrlLive)
  );
};

export const getAppRuntime = async (): Promise<AppRuntime> => {
  if (!runtime || (await hasApiUrlChanged())) {
    if (runtime) {
      await runtime.dispose();
      runtime = null;
    }
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
