import { expect, test } from "bun:test";

import { isConnectionRefused } from "../packages/server/src/deploy";

const socketError = (code: string) =>
  Object.assign(new Error("connect failed"), { code });

test("only a refused connection proves the port is free", () => {
  expect(isConnectionRefused(socketError("ECONNREFUSED"))).toBe(true);
  for (const code of ["EMFILE", "ENFILE", "EACCES", "EADDRNOTAVAIL"]) {
    expect(isConnectionRefused(socketError(code))).toBe(false);
  }
  expect(isConnectionRefused("ECONNREFUSED")).toBe(false);
});
