import { execFile } from "node:child_process";
import { promisify } from "node:util";

// oxlint-disable-next-line typescript/strict-void-return -- Node's execFile overload is supported by promisify and preserves subprocess failures.
export const execute = promisify(execFile);
