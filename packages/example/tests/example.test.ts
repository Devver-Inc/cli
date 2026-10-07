import { expect, test } from "bun:test";
import { displayTags } from "../index";

test("the example entry point normalizes tags", () => {
  expect(displayTags([" Beta ", "alpha", "BETA", ""])).toBe("alpha, beta");
});
