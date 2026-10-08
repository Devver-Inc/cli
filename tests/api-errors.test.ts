import { expect, test } from "bun:test";

import { formatBackendError } from "../packages/cli/errors";

test("backend errors preserve an actionable message", () => {
  expect(formatBackendError({ message: "UNKNOWN_CODE", statusCode: 404 })).toBe(
    "UNKNOWN_CODE (404)"
  );
  expect(
    formatBackendError({
      message: "UNIQUE_CONSTRAINT_VIOLATION",
      field: "apiKey",
      value: "sensitive-token",
      statusCode: 409,
    })
  ).toBe('A record with this value already exists. (field: "apiKey") (409)');
});
