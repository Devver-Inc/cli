import { Context, Data, Effect, Layer, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import type { HttpBody, HttpClientError } from "effect/http";

import { BackendErrorBodySchema, formatBackendError } from "./errors";
import type { BackendErrorBody } from "./errors";

/**
 * Effect-based HTTP client built on top of Effect's HTTP modules.
 *
 * Provides ApiClient (via Effect Context) so that any request function
 * can `yield* ApiClient` to get an authenticated, schema-validated client.
 * Auth is injected through the AuthToken service at the Layer level.
 * The API base URL is injected through the ApiBaseUrl service.
 */

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly status: number;
  readonly message: string;
  /** Machine-readable error code from the backend (e.g. "PROJECT_NOT_FOUND"). */
  readonly code?: string;
}> {}

export class AuthToken extends Context.Service<
  AuthToken,
  { readonly token: string | null }
>()("@devver/cli/api/client/AuthToken") {}

export class ApiBaseUrl extends Context.Service<
  ApiBaseUrl,
  { readonly url: string }
>()("@devver/cli/api/client/ApiBaseUrl") {}

export type ApiRequestError =
  | ApiError
  | HttpClientError.HttpClientError
  | HttpBody.HttpBodyError
  | Schema.SchemaError;

interface ApiClientService {
  readonly get: <A>(
    path: string,
    schema: Schema.Codec<A, unknown, never, unknown>
  ) => Effect.Effect<A, ApiRequestError>;

  // Preserve the concrete request DTO type at the transport seam.
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
  readonly post: <A, B>(
    path: string,
    body: B,
    schema: Schema.Codec<A, unknown, never, unknown>
  ) => Effect.Effect<A, ApiRequestError>;

  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
  readonly put: <A, B>(
    path: string,
    body: B,
    schema: Schema.Codec<A, unknown, never, unknown>
  ) => Effect.Effect<A, ApiRequestError>;

  readonly delete: <A>(
    path: string,
    schema: Schema.Codec<A, unknown, never, unknown>
  ) => Effect.Effect<A, ApiRequestError>;
}

export class ApiClient extends Context.Service<ApiClient, ApiClientService>()(
  "@devver/cli/api/client/ApiClient"
) {}

/**
 * Check HTTP response status. On failure, reads the response body to extract
 * the backend error code and details so the CLI can show actionable messages.
 */
const checkStatus = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<HttpClientResponse.HttpClientResponse, ApiError> =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response)
    : Effect.gen(function* () {
        const body: BackendErrorBody | undefined = yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(BackendErrorBodySchema)),
          // No backend error body is different from a malformed one; both use the status.
          Effect.orElseSucceed(() => undefined)
        );

        // The decoded backend schema permits a string or string array here.
        const code =
          // oxlint-disable-next-line anti-slop/no-runtime-typeof
          typeof body?.message === "string" ? body.message : undefined;
        const detail =
          body === undefined ? undefined : formatBackendError(body);

        const options = {
          status: response.status,
          message: detail ?? `Request failed with status ${response.status}`,
        };
        return yield* code === undefined
          ? new ApiError(options)
          : new ApiError({ ...options, code });
      });

export const ApiClientLive = Layer.effect(
  ApiClient,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const { token } = yield* AuthToken;
    const { url: baseUrl } = yield* ApiBaseUrl;

    const addAuth = (request: HttpClientRequest.HttpClientRequest) =>
      token !== null && token !== ""
        ? HttpClientRequest.setHeader(
            request,
            "Authorization",
            `Bearer ${token}`
          )
        : request;

    const makeRequest = <A>(
      request: HttpClientRequest.HttpClientRequest,
      schema: Schema.Codec<A, unknown, never, unknown>
    ): Effect.Effect<A, ApiRequestError> =>
      httpClient
        .execute(addAuth(request))
        .pipe(
          Effect.flatMap(checkStatus),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
          Effect.scoped
        );

    return {
      get: (path, schema) =>
        makeRequest(HttpClientRequest.get(`${baseUrl}${path}`), schema),

      post: (path, body, schema) =>
        HttpClientRequest.post(`${baseUrl}${path}`).pipe(
          HttpClientRequest.bodyJson(body),
          Effect.flatMap((request) => makeRequest(request, schema))
        ),

      put: (path, body, schema) =>
        HttpClientRequest.put(`${baseUrl}${path}`).pipe(
          HttpClientRequest.bodyJson(body),
          Effect.flatMap((request) => makeRequest(request, schema))
        ),

      delete: (path, schema) =>
        makeRequest(HttpClientRequest.delete(`${baseUrl}${path}`), schema),
    };
  })
);

/** Full layer: ApiClient + HTTP transport. Provide AuthToken and ApiBaseUrl before use. */
export const ApiClientLayer = ApiClientLive.pipe(
  Layer.provide(FetchHttpClient.layer)
);
