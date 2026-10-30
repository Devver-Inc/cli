import { execFile } from "node:child_process";
import { promisify } from "node:util";

// oxlint-disable-next-line typescript/strict-void-return -- Node's execFile overload preserves rejected subprocess failures through promisify.
export const execute = promisify(execFile);
