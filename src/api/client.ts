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

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly status: number;
  readonly message: string;
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

const BASE_URL = process.env.API_URL ?? "http://localhost:3000/api/v1"; // "https://api.devver.app/api/v1";

const checkStatus = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<HttpClientResponse.HttpClientResponse, ApiError> =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response)
    : Effect.fail(
        new ApiError({
          status: response.status,
          message: `Request failed with status ${response.status}`,
        })
      );

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

export const ApiClientLayer = ApiClientLive.pipe(
  Layer.provide(FetchHttpClient.layer)
);
