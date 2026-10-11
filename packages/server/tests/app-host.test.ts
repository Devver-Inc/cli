import { expect, test } from "bun:test";

import { deploymentIdFromHost } from "../app-host";

const ID = "235a4869-9dfe-42f2-b225-b2a0cee3cf47";

test("only a deployment hostname on the app listener selects a deployment", () => {
  expect(deploymentIdFromHost(`${ID}.localhost:4231`, 4231)).toBe(ID);
  for (const host of [
    "localhost:4231",
    `${ID}.localhost:9999`,
    `${ID}.localhost.evil:4231`,
    `other.${ID}.localhost:4231`,
    `${ID}.localhost:4231,evil.localhost:4231`,
    "not-a-deployment.localhost:4231",
    `${ID}.localhost:4231@evil.example`,
  ]) {
    expect(deploymentIdFromHost(host, 4231)).toBeUndefined();
  }
});
