import { expect, test } from "bun:test";
import { join } from "node:path";

import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

import { App } from "../src/tui/app";

test("shows honest deployment status and exits", async () => {
  let exits = 0;
  const setup = await testRender(
    <App
      onExit={() => {
        exits += 1;
      }}
      target={{ kind: "cloud", project: "demo" }}
      version="1.2.0"
    />,
    { width: 80, height: 20 }
  );
  try {
    const frame = await setup.waitForFrame((value) =>
      value.includes("Deployment browsing is not available yet")
    );
    expect(frame).toContain("No organization / demo");
    expect(frame).toContain("v1.2.0");
    expect(frame).not.toContain("storefront.devver.app");
    await act(async () => {
      setup.mockInput.pressKey("q");
      await Promise.resolve();
    });
    await setup.waitFor(() => exits === 1);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("organization switch failure never displays private errors", async () => {
  const setup = await testRender(
    <App
      onExit={() => undefined}
      target={{
        kind: "cloud",
        currentOrganization: "org-1",
        onSwitchOrganization: async () => {
          throw new Error("private credential");
        },
        organizations: [
          { id: "org-1", name: "Acme" },
          { id: "org-2", name: "Other" },
        ],
      }}
    />,
    { width: 80, height: 20 }
  );
  try {
    await act(async () => {
      setup.mockInput.pressKey("g");
      await Promise.resolve();
    });
    await setup.waitForFrame((value) => value.includes("Other"));
    await act(async () => {
      setup.mockInput.pressArrow("down");
      await Promise.resolve();
    });
    await act(async () => {
      setup.mockInput.pressEnter();
      await Promise.resolve();
    });
    const frame = await setup.waitForFrame((value) =>
      value.includes("Could not switch organization")
    );
    expect(frame).toContain("Acme / No project");
    expect(frame).not.toContain("private credential");
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("project picker persists selection only after success", async () => {
  const calls: string[] = [];
  const setup = await testRender(
    <App
      onExit={() => undefined}
      target={{
        kind: "cloud",
        currentOrganization: "org-1",
        currentProjectId: "p1",
        organizations: [{ id: "org-1", name: "Acme" }],
        loadProjects: async () => [
          { id: "p1", name: "Storefront" },
          { id: "p2", name: "Dashboard" },
        ],
        onSwitchProject: async (id) => {
          calls.push(id);
        },
      }}
    />,
    { width: 80, height: 20 }
  );
  try {
    await setup.waitForFrame((value) => value.includes("Acme / Storefront"));
    await act(async () => {
      setup.mockInput.pressKey("p");
      await Promise.resolve();
    });
    await setup.waitForFrame((value) => value.includes("Dashboard"));
    await act(async () => {
      setup.mockInput.pressArrow("down");
      await Promise.resolve();
    });
    await act(async () => {
      setup.mockInput.pressEnter();
      await Promise.resolve();
    });
    const frame = await setup.waitForFrame((value) =>
      value.includes("Acme / Dashboard")
    );
    expect(frame).toContain("Deployment browsing is not available yet");
    expect(calls).toEqual(["p2"]);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

for (const { target, label } of [
  {
    target: { kind: "local", server: "dev", workspace: "site" } as const,
    label: "dev / workspace: site",
  },
  { target: { kind: "none" } as const, label: "No target selected" },
]) {
  test(`${target.kind} target hides cloud selectors`, async () => {
    const setup = await testRender(
      <App target={target} onExit={() => undefined} />,
      { width: 80, height: 20 }
    );
    try {
      const frame = await setup.waitForFrame((value) => value.includes(label));
      expect(frame).toContain("q quit");
      expect(frame).not.toContain("organization");
      expect(frame).not.toContain("project ·");
      for (const key of ["g", "p"]) {
        await act(async () => {
          setup.mockInput.pressKey(key);
          await Promise.resolve();
        });
        await setup.renderOnce();
        expect(setup.captureCharFrame()).toContain(label);
        expect(setup.captureCharFrame()).not.toContain("Select organization");
        expect(setup.captureCharFrame()).not.toContain("Select project");
      }
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
}

test("the TUI releases the renderer and never blocks process exit", () => {
  const probe = Bun.spawnSync(
    ["bun", "run", join(import.meta.dir, "fixtures", "tui-probe.ts")],
    { cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" }
  );
  const output = probe.stderr.toString();
  expect(probe.exitCode, output).toBe(0);
  expect(output).toContain('PROBE {"outcome":"timeout"}');
});
