import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Awaited `execFile` for the native service managers. It rejects on a nonzero
 * exit, which is what every supervisor check relies on to fail closed.
 */
// oxlint-disable-next-line typescript/strict-void-return -- Node's execFile overload is supported by promisify and preserves subprocess failures.
export const execute = promisify(execFile);
