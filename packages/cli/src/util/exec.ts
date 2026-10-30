import { execFile } from "node:child_process";
import { promisify } from "node:util";

// oxlint-disable-next-line typescript/strict-void-return -- Node's execFile overload is supported by promisify and preserves subprocess failures.
export const execute = promisify(execFile);

// Node's execFile rejects with an Error carrying `code` (exit status or signal)
// and `stderr`. launchctl reports an already-stopped job as exit 3 with
// "No such process" on stderr.
export const isProcessUnknown = (
  error: unknown
): error is Error & { code: number; stderr: string } =>
  error instanceof Error &&
  "code" in error &&
  error.code === 3 &&
  "stderr" in error &&
  typeof error.stderr === "string" &&
  error.stderr.includes("No such process");
