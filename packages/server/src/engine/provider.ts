import type { Effect } from "effect";
import { Data } from "effect";
import type { Json, JsonObject } from "effect/Schema";

export class ProviderFailure extends Data.TaggedError("ProviderFailure")<{
  readonly message: string;
  // A provider author supplies a JSON detail it has already sanitized; the
  // engine stores it opaquely so callers can map it at their own seam.
  readonly detail?: Json | undefined;
}> {}

export interface ProviderCall {
  readonly id: string;
  readonly inputs: Json;
  readonly previousOutput: JsonObject | undefined;
}

export interface ResourceProvider {
  readonly id: string;
  readonly reconcile: (
    call: ProviderCall
  ) => Effect.Effect<unknown, ProviderFailure>;
  readonly remove: (call: ProviderCall) => Effect.Effect<void, ProviderFailure>;
}
