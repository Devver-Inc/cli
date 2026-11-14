import { Data } from "effect";

export type ValidationReason =
  | "invalid-declaration"
  | "invalid-concurrency"
  | "invalid-provider"
  | "duplicate-provider"
  | "duplicate-id"
  | "unknown-provider"
  | "type-change"
  | "invalid-reference"
  | "invalid-inputs"
  | "missing-dependency"
  | "unresolved-reference"
  | "deleting-resource"
  | "cycle";

const validationMessages = {
  "invalid-declaration": "resource declarations are invalid",
  "invalid-concurrency": "resource engine concurrency is invalid",
  "invalid-provider": "resource provider id is invalid",
  "duplicate-provider": "resource provider ids must be unique",
  "duplicate-id": "resource ids must be unique",
  "unknown-provider": "resource declarations name an unknown provider",
  "type-change": "resource provider cannot change for an existing id",
  "invalid-reference": "resource references are invalid",
  "invalid-inputs": "resource inputs are invalid",
  "missing-dependency": "resource reference targets a missing resource",
  "unresolved-reference": "resource reference targets an unresolved resource",
  "deleting-resource": "resource is being deleted",
  cycle: "resource graph contains a cycle",
} as const satisfies Record<ValidationReason, string>;

export class EngineValidationError extends Data.TaggedError(
  "EngineValidationError"
)<{
  readonly reason: ValidationReason;
  readonly id: string | undefined;
  readonly message: string;
}> {}

export class EngineStateError extends Data.TaggedError("EngineStateError")<{
  readonly message: string;
}> {}

export class EngineBusyError extends Data.TaggedError("EngineBusyError")<{
  readonly message: string;
}> {}

export class EngineOperationError extends Data.TaggedError(
  "EngineOperationError"
)<{
  readonly id: string;
  readonly stage: "reconcile" | "remove";
  readonly message: string;
}> {}

export type TeardownRefusalReason =
  | "invalid-id"
  | "duplicate-id"
  | "unknown-id"
  | "missing-provider"
  | "protected"
  | "in-use";

const refusalMessages = {
  "invalid-id": "teardown ids are invalid",
  "duplicate-id": "teardown ids must be unique",
  "unknown-id": "teardown names an unknown resource",
  "missing-provider": "teardown names a resource without a provider",
  protected: "teardown names a protected resource",
  "in-use": "teardown names a resource that is still in use",
} as const satisfies Record<TeardownRefusalReason, string>;

export class EngineTeardownRefusal extends Data.TaggedError(
  "EngineTeardownRefusal"
)<{
  readonly reason: TeardownRefusalReason;
  readonly ids: readonly string[];
  readonly message: string;
}> {}

export type EngineError =
  | EngineValidationError
  | EngineStateError
  | EngineBusyError
  | EngineOperationError
  | EngineTeardownRefusal;

export const validationMessage = (reason: ValidationReason): string =>
  validationMessages[reason];

export const refusalMessage = (reason: TeardownRefusalReason): string =>
  refusalMessages[reason];
