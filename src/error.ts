import { ApiError } from "./api/client";
import { getErrorMessage } from "./api/errors";

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

  // ── ApiError (our structured HTTP errors) ─────────────────────────────
  if (input instanceof ApiError) {
    const { code, message, status } = input;

    // If we have a known backend error code, show the friendly message
    if (code) {
      const friendly = getErrorMessage(code, message);
      return status ? `${friendly} (${status})` : friendly;
    }

    // No code — just show the message (already formatted by checkStatus)
    return message;
  }

  // ── DeployAbortError ─────────────────────────────────────────────────
  if (input instanceof DeployAbortError) {
    return input.message;
  }

  // ── Generic Error ────────────────────────────────────────────────────
  if (input instanceof Error) {
    const msg = input.message || String(input);

    // Effect wraps failed Effects in a FiberFailure (extends Error). When the
    // underlying cause is a plain object, the message renders as
    // "[object Object]" — useless. Recover something readable.
    if (/\[object Object\]/i.test(msg)) {
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

  // ── Fallback ─────────────────────────────────────────────────────────
  return `Unexpected error: ${String(input)}`;
}

export class DeployAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployAbortError";
  }
}
