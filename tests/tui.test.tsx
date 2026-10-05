import { expect, test } from "bun:test";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App } from "../src/tui/app";

test("tree connectors, selection, tabs and compare base follow keyboard navigation", async () => {
  let exits = 0;
  const setup = await testRender(
    <App
      onExit={() => exits++}
      organizations={[{ id: "org-1", name: "acme" }]}
      project="demo"
      version="1.2.0 (test)"
    />,
    { width: 110, height: 30 }
  );
  try {
    let frame = await setup.waitForFrame((value) =>
      value.includes("shorter copy")
    );
    expect(frame).toContain("╭──");
    expect(frame).toContain("├──");
    expect(frame).toContain("└──");
    expect(frame).toContain("◆");
    expect(frame).toContain("Much clearer.");
    expect(frame).toContain("v1.2.0 (test)");
    expect(frame).toContain("acme / demo");
    expect(exits).toBe(0);
    expect(
      setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .every((span) => span.bg.intent === "default")
    ).toBe(true);

    act(() => setup.mockInput.pressKey("d"));
    frame = await setup.waitForFrame((value) =>
      value.includes("Compared with checkout")
    );
    expect(frame).toContain("Place order");

    act(() => setup.mockInput.pressArrow("down"));
    frame = await setup.waitForFrame(
      (value) => value.includes("high contrast") && value.includes("73e2d41")
    );
    expect(frame).toContain("Compared with checkout");
    expect(
      setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .every((span) => span.bg.intent === "default")
    ).toBe(true);
    act(() => setup.mockInput.pressKey("b"));
    frame = await setup.waitForFrame((value) =>
      value.includes("Select another deployment to see what")
    );
    expect(frame).toContain("diff ↔ high contrast");

    act(() => setup.mockInput.pressKey("k"));
    frame = await setup.waitForFrame((value) =>
      value.includes("Compared with high contrast")
    );
    expect(frame).toContain("shorter copy");
    act(() => setup.mockInput.pressKey("f"));
    await setup.waitForFrame((value) => value.includes("Much clearer."));
  } finally {
    setup.renderer.destroy();
  }
});

test("narrow layout switches panes and selection scrolls to the last deployment", async () => {
  let exits = 0;
  const setup = await testRender(
    <App onExit={() => exits++} version="1.2.0" />,
    { width: 60, height: 18 }
  );
  try {
    await setup.waitForFrame((value) => value.includes("deployment tree"));
    act(() => {
      for (let index = 0; index < 7; index++) {
        setup.mockInput.pressKey("j");
      }
    });
    const frame = await setup.waitForFrame((value) =>
      value.includes("two-step welcome")
    );
    expect(frame).toContain("◆");
    act(() => setup.mockInput.pressTab());
    const detail = await setup.waitForFrame(
      (value) =>
        value.includes("selected deployment") &&
        value.includes("two-step welcome")
    );
    expect(detail).not.toContain("deployment tree");
    expect(detail).toContain("v1.2.0");
    act(() => setup.mockInput.pressTab());
    await setup.waitForFrame((value) => value.includes("deployment tree"));
    act(() => setup.mockInput.pressKey("q"));
    await setup.waitFor(() => exits === 1);
  } finally {
    setup.renderer.destroy();
  }
});

test("organization selector commits on success, keeps current on failure and cancels", async () => {
  const calls: string[] = [];
  let fail = true;
  const setup = await testRender(
    <App
      currentOrganization="org-1"
      onExit={() => calls.push("exit")}
      onSwitchOrganization={(current, id) => {
        calls.push(`${current} -> ${id}`);
        return fail
          ? Promise.reject(new Error("secret must not be shown"))
          : Promise.resolve();
      }}
      organizations={[
        { id: "org-1", name: "Acme" },
        { id: "org-2", name: "Another team" },
      ]}
    />,
    { width: 80, height: 18 }
  );
  try {
    await setup.waitForFrame((frame) => frame.includes("Acme / storefront"));
    act(() => setup.mockInput.pressKey("g"));
    await setup.waitForFrame((frame) => frame.includes("organizations"));
    act(() => setup.mockInput.pressArrow("down"));
    act(() => setup.mockInput.pressEnter());
    let frame = await setup.waitForFrame((value) =>
      value.includes("Could not switch organization")
    );
    expect(frame).toContain("Acme / storefront");
    expect(frame).toContain("Check your selection");
    expect(frame).not.toContain("secret must not be shown");
    expect(calls).toEqual(["org-1 -> org-2"]);
    fail = false;
    act(() => setup.mockInput.pressKey("g"));
    await setup.waitForFrame((value) => value.includes("Another team"));
    act(() => setup.mockInput.pressArrow("down"));
    act(() => setup.mockInput.pressEnter());
    frame = await setup.waitForFrame((value) =>
      value.includes("Another team / storefront")
    );
    expect(frame).not.toContain("organizations");
    act(() => setup.mockInput.pressKey("g"));
    frame = await setup.waitForFrame((value) =>
      value.includes("Another team (current)")
    );
    act(() => setup.mockInput.pressEscape());
    await Bun.sleep(150); // Escape is buffered briefly to distinguish Alt sequences.
    frame = await setup.waitForFrame((value) =>
      value.includes("deployment tree")
    );
    expect(frame).toContain("Another team / storefront");
    act(() => setup.mockInput.pressKey("g"));
    await setup.waitForFrame((value) =>
      value.includes("Another team (current)")
    );
    act(() => setup.mockInput.pressArrow("up"));
    act(() => setup.mockInput.pressEnter());
    frame = await setup.waitForFrame((value) =>
      value.includes("Acme / storefront")
    );
    expect(calls).toEqual([
      "org-1 -> org-2",
      "org-1 -> org-2",
      "org-2 -> org-1",
    ]);
  } finally {
    setup.renderer.destroy();
  }
});

test("organization switch renders immediately but loads projects only after credentials refresh", async () => {
  let complete: (() => void) | undefined;
  let loaded = 0;
  const setup = await testRender(
    <App
      currentOrganization="org-1"
      currentProjectId="project-1"
      loadProjects={() => {
        loaded++;
        return Promise.resolve([{ id: "project-1", name: "Storefront" }]);
      }}
      onExit={() => undefined}
      onSwitchOrganization={() =>
        new Promise<void>((resolve) => {
          complete = resolve;
        })
      }
      organizations={[
        { id: "org-1", name: "Acme" },
        { id: "org-2", name: "Other" },
      ]}
    />,
    { width: 80, height: 18 }
  );
  try {
    await setup.waitForFrame((frame) => frame.includes("Acme / Storefront"));
    expect(loaded).toBe(1);
    act(() => setup.mockInput.pressKey("g"));
    await setup.waitForFrame((frame) => frame.includes("organizations"));
    act(() => setup.mockInput.pressKey("j"));
    act(() => setup.mockInput.pressEnter());
    const frame = await setup.waitForFrame((value) =>
      value.includes("Other / Switching organization")
    );
    expect(frame).not.toContain("Storefront");
    expect(loaded).toBe(1);
    act(() => complete?.());
    await setup.waitForFrame((value) =>
      value.includes("Other / Select project")
    );
    expect(loaded).toBe(2);
  } finally {
    setup.renderer.destroy();
  }
});

test("project selector shows real projects, commits only successful selections", async () => {
  const calls: string[] = [];
  let fail = true;
  const setup = await testRender(
    <App
      currentOrganization="org-1"
      currentProjectId="project-1"
      loadProjects={() =>
        Promise.resolve([
          { id: "project-1", name: "Storefront" },
          { id: "project-2", name: "Dashboard" },
        ])
      }
      onExit={() => undefined}
      onSwitchProject={(id) => {
        calls.push(id);
        return fail
          ? Promise.reject(new Error("private error"))
          : Promise.resolve();
      }}
      organizations={[{ id: "org-1", name: "Acme" }]}
    />,
    { width: 80, height: 20 }
  );
  try {
    await setup.waitForFrame((frame) => frame.includes("Acme / Storefront"));
    act(() => setup.mockInput.pressKey("p"));
    await setup.waitForFrame((frame) => frame.includes("Dashboard"));
    act(() => setup.mockInput.pressKey("j"));
    act(() => setup.mockInput.pressEnter());
    let frame = await setup.waitForFrame((value) =>
      value.includes("Could not switch project")
    );
    expect(frame).toContain("Acme / Storefront");
    expect(frame).not.toContain("private error");
    fail = false;
    act(() => setup.mockInput.pressEnter());
    frame = await setup.waitForFrame((value) =>
      value.includes("Acme / Dashboard")
    );
    expect(frame).toContain("deployment tree");
    expect(calls).toEqual(["project-2", "project-2"]);
  } finally {
    setup.renderer.destroy();
  }
});

test("switching organization reloads its projects and hides the old selection", async () => {
  let organization = "org-1";
  const setup = await testRender(
    <App
      currentOrganization="org-1"
      currentProjectId="project-1"
      loadProjects={() =>
        Promise.resolve(
          organization === "org-1"
            ? [{ id: "project-1", name: "Storefront" }]
            : [{ id: "project-2", name: "Dashboard" }]
        )
      }
      onExit={() => undefined}
      onSwitchOrganization={(_current, id) => {
        organization = id;
        return Promise.resolve();
      }}
      onSwitchProject={() => Promise.resolve()}
      organizations={[
        { id: "org-1", name: "Acme" },
        { id: "org-2", name: "Other" },
      ]}
    />,
    { width: 80, height: 18 }
  );
  try {
    await setup.waitForFrame((frame) => frame.includes("Acme / Storefront"));
    act(() => setup.mockInput.pressKey("g"));
    await setup.waitForFrame((frame) => frame.includes("Other"));
    act(() => setup.mockInput.pressArrow("down"));
    act(() => setup.mockInput.pressEnter());
    const frame = await setup.waitForFrame((value) =>
      value.includes("Other / Select project")
    );
    expect(frame).not.toContain("Other / Storefront");
    act(() => setup.mockInput.pressKey("p"));
    await setup.waitForFrame((value) => value.includes("Dashboard"));
  } finally {
    setup.renderer.destroy();
  }
});

test("organization selector explains an empty account without switching", async () => {
  const setup = await testRender(<App onExit={() => undefined} />, {
    width: 60,
    height: 18,
  });
  try {
    act(() => setup.mockInput.pressKey("g"));
    const frame = await setup.waitForFrame((value) =>
      value.includes("No organizations available")
    );
    expect(frame).toContain("devver auth login");
    act(() => setup.mockInput.pressEnter());
    expect(setup.captureCharFrame()).toContain("No organizations available");
  } finally {
    setup.renderer.destroy();
  }
});

test("Ctrl+C exits", async () => {
  let exits = 0;
  const setup = await testRender(<App onExit={() => exits++} />, {
    width: 60,
    height: 18,
  });
  try {
    act(() => setup.mockInput.pressCtrlC());
    await setup.waitFor(() => exits === 1);
  } finally {
    setup.renderer.destroy();
  }
});

test("the TUI releases the renderer and never blocks process exit", () => {
  const probe = Bun.spawnSync(
    ["bun", "run", join(import.meta.dir, "fixtures", "tui-probe.ts")],
    { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  );
  const output = probe.stderr.toString();

  expect(probe.exitCode, output).toBe(0);
  expect(output).toContain('PROBE {"outcome":"timeout"}');
});
