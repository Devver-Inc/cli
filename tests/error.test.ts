import { describe, expect, test } from "bun:test";
import { DeployAbortError, FormatError } from "../src/error";

describe("FormatError", () => {
  test("formats an Error instance", () => {
    const err = new Error("boom");
    expect(FormatError(err)).toBe("Unknown error : Error: boom");
  });

  test("formats a string", () => {
    expect(FormatError("something broke")).toBe(
      "Unknown error : something broke"
    );
  });

  test("formats null/undefined", () => {
    expect(FormatError(null)).toBe("Unknown error : null");
    expect(FormatError(undefined)).toBe("Unknown error : undefined");
  });
});

describe("DeployAbortError", () => {
  test("has correct name and message", () => {
    const err = new DeployAbortError("user cancelled");
    expect(err.name).toBe("DeployAbortError");
    expect(err.message).toBe("user cancelled");
  });

  test("is an instance of Error", () => {
    const err = new DeployAbortError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DeployAbortError);
  });

  test("produces a stack trace", () => {
    const err = new DeployAbortError("trace test");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("DeployAbortError");
  });
});
