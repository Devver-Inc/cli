import {
  FetchHttpClient,
  type HttpBody,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import {
  Context,
  Data,
  Effect,
  Layer,
  type ParseResult,
  type Schema,
} from "effect";
import { formatBackendError } from "./errors";

/**
 * Effect-based HTTP client built on top of @effect/platform.
 *
 * Provides ApiClient (via Effect Context) so that any request function
 * can `yield* ApiClient` to get an authenticated, schema-validated client.
 * Auth is injected through the AuthToken service at the Layer level.
 */

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly status: number;
  readonly message: string;
  /** Machine-readable error code from the backend (e.g. "PROJECT_NOT_FOUND"). */
  readonly code?: string;
  /** Full parsed response body from the backend, if available. */
  readonly body?: Record<string, unknown>;
}> {}

export class AuthToken extends Context.Tag("AuthToken")<
  AuthToken,
  { readonly token: string | null }
>() {}

export type ApiRequestError =
  | ApiError
  | HttpClientError.HttpClientError
  | HttpBody.HttpBodyError
  | ParseResult.ParseError;

interface ApiClientService {
  readonly get: <A, I>(
    path: string,
    schema: Schema.Schema<A, I>
  ) => Effect.Effect<A, ApiRequestError>;

  readonly post: <A, I, B>(
    path: string,
    body: B,
    schema: Schema.Schema<A, I>
  ) => Effect.Effect<A, ApiRequestError>;

  readonly put: <A, I, B>(
    path: string,
    body: B,
    schema: Schema.Schema<A, I>
  ) => Effect.Effect<A, ApiRequestError>;

  readonly delete: <A, I>(
    path: string,
    schema: Schema.Schema<A, I>
  ) => Effect.Effect<A, ApiRequestError>;
}

export class ApiClient extends Context.Tag("ApiClient")<
  ApiClient,
  ApiClientService
>() {}

const BASE_URL = process.env.API_URL ?? "https://app.devver.app/api/v1";

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
        // Try to parse the response body as JSON for error details.
        // NestJS responses look like:
        //   { statusCode: 404, message: "PROJECT_NOT_FOUND", error: "Not Found" }
        let body: Record<string, unknown> | undefined;
        try {
          body = (yield* Effect.orDie(
            response.json as Effect.Effect<unknown, never>
          )) as Record<string, unknown>;
        } catch {
          // Body is not JSON — we still have the status code
        }

        const code =
          typeof body?.message === "string" ? body.message : undefined;
        const detail = body
          ? formatBackendError(body as Parameters<typeof formatBackendError>[0])
          : undefined;

        return yield* Effect.fail(
          new ApiError({
            status: response.status,
            message: detail ?? `Request failed with status ${response.status}`,
            code,
            body,
          })
        );
      });

export const ApiClientLive = Layer.effect(
  ApiClient,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const { token } = yield* AuthToken;

    const addAuth = (request: HttpClientRequest.HttpClientRequest) =>
      token
        ? HttpClientRequest.setHeader(
            request,
            "Authorization",
            `Bearer ${token}`
          )
        : request;

    const makeRequest = <A, I>(
      request: HttpClientRequest.HttpClientRequest,
      schema: Schema.Schema<A, I>
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
        makeRequest(HttpClientRequest.get(`${BASE_URL}${path}`), schema),

      post: (path, body, schema) =>
        HttpClientRequest.post(`${BASE_URL}${path}`).pipe(
          HttpClientRequest.bodyJson(body),
          Effect.flatMap((request) => makeRequest(request, schema))
        ),

      put: (path, body, schema) =>
        HttpClientRequest.put(`${BASE_URL}${path}`).pipe(
          HttpClientRequest.bodyJson(body),
          Effect.flatMap((request) => makeRequest(request, schema))
        ),

      delete: (path, schema) =>
        makeRequest(HttpClientRequest.del(`${BASE_URL}${path}`), schema),
    };
  })
);

/** Full layer: ApiClient + HTTP transport. Provide AuthToken before use. */
export const ApiClientLayer = ApiClientLive.pipe(
  Layer.provide(FetchHttpClient.layer)
);
