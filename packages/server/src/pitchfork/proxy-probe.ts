import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

const DEADLINE = 10_000;
const INTERVAL = 200;
const TIMEOUT = 1000;

// Pitchfork reports its configured port even if another process bound it.
export const proxyAnswers = (port: number) =>
  Effect.gen(function* () {
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    const deadline = Date.now() + DEADLINE;
    while (Date.now() < deadline) {
      const answered = yield* client
        .execute(HttpClientRequest.get(`http://127.0.0.1:${port}/`))
        .pipe(
          Effect.flatMap((response) =>
            response.status === 404 || response.status === 502
              ? response.text.pipe(
                  Effect.map(
                    (body) =>
                      body.includes("No route for <code>127.0.0.1</code>") ||
                      body.includes("No daemon found for host '127.0.0.1'")
                  )
                )
              : Effect.succeed(false)
          ),
          Effect.timeout(TIMEOUT),
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
          }),
          Effect.scoped,
          Effect.orElseSucceed(() => false)
        );
      if (answered) {
        return true;
      }
      yield* Effect.sleep(INTERVAL);
    }
    return false;
  }).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off -- The Promise host opens this HTTP client at its Effect entry point.
    Effect.provide(FetchHttpClient.layer)
  );
