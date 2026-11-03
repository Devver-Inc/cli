import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { DeployFailure } from "../api";

const DEADLINE = 20_000;
const INTERVAL = 200;
const TIMEOUT = 1000;

export const reachable = (url: string) =>
  Effect.gen(function* () {
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    const deadline = Date.now() + DEADLINE;
    let answered = 0;
    while (Date.now() < deadline) {
      const status = yield* client.execute(HttpClientRequest.get(url)).pipe(
        Effect.map((response) => response.status),
        Effect.timeout(TIMEOUT),
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
        }),
        Effect.scoped,
        Effect.orElseSucceed(() => 0)
      );
      if (status >= 200 && status < 300) {
        return undefined;
      }
      if (status !== 0) {
        answered = status;
      }
      yield* Effect.sleep(INTERVAL);
    }
    return yield* new DeployFailure({
      stage: "readiness",
      message:
        answered === 0
          ? "readiness: the app URL did not answer before the readiness deadline"
          : `readiness: the app URL answered with status ${answered}`,
    });
  });
