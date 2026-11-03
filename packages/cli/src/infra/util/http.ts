import { Effect, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

interface JsonRequest<S extends Schema.ConstraintDecoder<unknown>, E> {
  readonly url: string;
  readonly schema: S;
  readonly limit: number;
  readonly timeout: number;
  readonly onError: (message: string) => E;
}

export const fetchJson = <S extends Schema.ConstraintDecoder<unknown>, E>({
  url,
  schema,
  limit,
  timeout,
  onError,
}: JsonRequest<S, E>): Effect.Effect<S["Type"], E> => {
  const decode = Schema.decodeUnknownSync(schema);
  const read = Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader("Accept", "application/json")
        )
      )
      .pipe(Effect.mapError(() => `Could not reach ${url}`));
    if (response.status !== 200) {
      return yield* Effect.fail(`${url} returned HTTP ${response.status}`);
    }
    const body = yield* Stream.runFoldEffect(
      response.stream,
      () => Buffer.alloc(0),
      (accumulated, chunk) =>
        accumulated.length + chunk.length > limit
          ? Effect.fail(`${url} returned too much data`)
          : Effect.succeed(Buffer.concat([accumulated, chunk]))
    ).pipe(Effect.mapError(() => `Could not read ${url}`));
    return yield* Effect.try({
      try: () =>
        decode(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))
        ),
      catch: () => `${url} returned an unexpected response`,
    });
  });
  return read.pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(`${url} did not answer in time`),
    }),
    Effect.mapError(onError),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    // @effect-diagnostics-next-line strictEffectProvide:off -- An untrusted public endpoint provides its own unauthenticated HTTP client.
    Effect.provide(FetchHttpClient.layer),
    Effect.scoped
  );
};
