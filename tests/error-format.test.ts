import { expect, test } from "bun:test";

import { formatError } from "../packages/cli/src/error";

test("opaque Effect errors reveal a readable cause, not arbitrary error properties", () => {
  expect(
    formatError(new Error("[object Object]", { cause: new Error("safe") }))
  ).toBe("safe");
  const opaque = Object.assign(new Error("[object Object]"), {
    token: "sensitive-token",
  });
  expect(formatError(opaque)).toBe("Unexpected error");
});
