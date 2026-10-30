import { expect, test } from "bun:test";

import { instanceParent } from "../identity";
import { serve } from "../index";
import { verifyWindowsPrivate } from "../windows-acl";

test("server package exposes its entrypoint and owner-only state APIs", async () => {
  expect(serve).toBeInstanceOf(Function);
  expect(verifyWindowsPrivate).toBeInstanceOf(Function);
  let failure: unknown;
  try {
    await instanceParent("invalid name");
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toHaveProperty(
    "message",
    expect.stringContaining("Invalid server instance name")
  );
});
