import { ApiError } from "./api/client";
import { getErrorMessage } from "./api/errors";

// Effect wraps failed Effects in a FiberFailure (extends Error) whose message
// renders as "[object Object]" — useless. Defined at module scope so the
// regex literal isn't re-allocated on every call (useTopLevelRegex).
const OBJECT_OBJECT_RE = /\[object Object\]/iu;

const isString = (value: unknown): value is string => typeof value === "string";

export class DeployAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployAbortError";
  }
}

function formatApiError(err: ApiError): string {
  const { code, message, status } = err;
  // If we have a known backend error code, show the friendly message
  if (code !== undefined && code !== "") {
    const friendly = getErrorMessage(code, message);
    return status === 0 ? friendly : `${friendly} (${status})`;
  }
  // No code — just show the message (already formatted by checkStatus)
  return message;
}

/**
 * Format an unknown error into a human-readable CLI message.
 *
 * - ApiError: extracts backend error code and maps it to a friendly message
 * - DeployAbortError: shows the abort reason
 * - Error: shows .message
 * - anything else: generic fallback
 *
 * Returns `undefined` for nullish input.
 */
// Errors from Effect finalizers can contain arbitrary thrown values.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function formatError(input: unknown): string | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }

  // ApiError (our structured HTTP errors)
  if (input instanceof ApiError) {
    return formatApiError(input);
  }

  // DeployAbortError
  if (input instanceof DeployAbortError) {
    return input.message;
  }

  // Effect's FiberFailure may render a cause as "[object Object]".
  if (input instanceof Error) {
    const message = input.message === "" ? String(input) : input.message;
    if (!OBJECT_OBJECT_RE.test(message)) {
      return message;
    }
    if (input.cause !== undefined) {
      const causeMessage = formatError(input.cause);
      if (causeMessage !== undefined && causeMessage !== "") {
        return causeMessage;
      }
    }
    return "Unexpected error";
  }

  // Do not stringify arbitrary objects, which could carry credentials.
  // A thrown string is already the intended message.
  return isString(input) ? `Unexpected error: ${input}` : "Unexpected error";
}
