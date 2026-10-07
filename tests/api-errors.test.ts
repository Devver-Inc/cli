import { expect, test } from "bun:test";
import { formatBackendError } from "../packages/cli/src/api/errors";

test("backend errors preserve an actionable message", () => {
  expect(formatBackendError({ message: "UNKNOWN_CODE", statusCode: 404 })).toBe(
    "UNKNOWN_CODE (404)"
  );
});
