import { expect, test } from "bun:test";
import { instanceParent } from "../identity";
import { serve } from "../index";
import { verifyWindowsPrivate } from "../windows-acl";

test("server package exposes its entrypoint and owner-only state APIs", async () => {
  expect(typeof serve).toBe("function");
  expect(typeof verifyWindowsPrivate).toBe("function");
  await expect(instanceParent("invalid name")).rejects.toThrow(
    "Invalid server instance name"
  );
});
