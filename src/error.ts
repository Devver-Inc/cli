import { ApiError } from "./api/client";
import { getErrorMessage } from "./api/errors";

// Effect wraps failed Effects in a FiberFailure (extends Error) whose message
// renders as "[object Object]" — useless. Defined at module scope so the
// regex literal isn't re-allocated on every call (useTopLevelRegex).
const OBJECT_OBJECT_RE = /\[object Object\]/i;

function formatApiError(err: ApiError): string {
  const { code, message, status } = err;
  // If we have a known backend error code, show the friendly message
  if (code) {
    const friendly = getErrorMessage(code, message);
    return status ? `${friendly} (${status})` : friendly;
  }
  // No code — just show the message (already formatted by checkStatus)
  return message;
}

/** Recover a readable message from Effect's FiberFailure-wrapped errors,
 * whose `.message` renders as "[object Object]". */
function formatFiberFailure(input: Error): string {
  const msg = input.message || String(input);
  if (OBJECT_OBJECT_RE.test(msg)) {
    const any = input as { cause?: unknown };
    if (any.cause !== undefined) {
      const causeMsg = FormatError(any.cause);
      if (causeMsg) {
        return causeMsg;
      }
    }
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return `${input.name}: ${msg}`;
    }
  }
  return msg;
}

/**
 * Format an unknown error into a human-readable CLI message.
 *
 * - ApiError: extracts backend error code and maps it to a friendly message
 * - DeployAbortError: shows the abort reason
 * - Error: shows .message
 * - anything else: generic fallback
 *
 * Returns `undefined` only when the input is `undefined`.
 */
export function FormatError(input: unknown): string | undefined {
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

  // Generic Error
  if (input instanceof Error) {
    return formatFiberFailure(input);
  }

  // Fallback
  return `Unexpected error: ${String(input)}`;
}

export class DeployAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployAbortError";
  }
}
