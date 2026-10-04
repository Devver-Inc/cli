import { expect, test } from "bun:test";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App } from "../src/tui/app";

test("tree connectors, selection, tabs and compare base follow keyboard navigation", async () => {
  let exits = 0;
  const setup = await testRender(
    <App onExit={() => exits++} project="demo" version="1.2.0 (test)" />,
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
