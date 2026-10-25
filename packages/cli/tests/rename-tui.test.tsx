import { expect, test } from "bun:test";

import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

import { App } from "../src/tui/app";

const id = "11111111-1111-4111-8111-111111111111";
const deployments = async () => [
  { deploymentId: id, status: "ready" as const, stage: null },
];

test("r edits a local deployment name without changing its id; escape cancels", async () => {
  const saved: { id: string; name: string }[] = [];
  const setup = await testRender(
    <App
      onExit={() => undefined}
      target={{
        kind: "local",
        server: "dev",
        workspace: "site",
        loadDeployments: deployments,
        renameDeployment: async (deploymentId, name) => {
          saved.push({ id: deploymentId, name });
          return { displayName: name };
        },
      }}
    />,
    { width: 90, height: 14 }
  );
  try {
    await setup.waitForFrame((frame) => frame.includes("11111111 ready"));
    await act(async () => {
      setup.mockInput.pressKey("r");
      await setup.mockInput.typeText("Discard");
      setup.mockInput.pressEscape();
    });
    expect(saved).toEqual([]);
    await act(async () => {
      setup.mockInput.pressKey("r");
    });
    await setup.waitForFrame((frame) => frame.includes("Rename:"));
    await act(async () => {
      await setup.mockInput.typeText("H");
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Rename: H");
    await act(async () => {
      await setup.mockInput.typeText("omepage");
      setup.mockInput.pressEnter();
      await Promise.resolve();
    });
    const frame = await setup.waitForFrame((value) =>
      value.includes("Homepage (11111111) ready")
    );
    expect(frame).toContain("Deployment renamed.");
    expect(saved).toEqual([{ id, name: "Homepage" }]);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("an unsupported server leaves the name unchanged and reports failure", async () => {
  const setup = await testRender(
    <App
      onExit={() => undefined}
      target={{
        kind: "local",
        server: "old",
        workspace: "site",
        loadDeployments: deployments,
        renameDeployment: async () => {
          throw new Error("old endpoint");
        },
      }}
    />,
    { width: 90, height: 14 }
  );
  try {
    await setup.waitForFrame((frame) => frame.includes("11111111 ready"));
    await act(async () => {
      setup.mockInput.pressKey("r");
    });
    await setup.waitForFrame((frame) => frame.includes("Rename:"));
    await act(async () => {
      await setup.mockInput.typeText("Proposed");
      setup.mockInput.pressEnter();
      await Promise.resolve();
    });
    const frame = await setup.waitForFrame((value) =>
      value.includes("Could not rename deployment")
    );
    expect(frame).toContain("11111111 ready");
    expect(frame).not.toContain("Proposed (11111111)");
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});
