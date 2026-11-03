import { expect, test } from "bun:test";
import { join } from "node:path";

const cli = join(import.meta.dir, "../packages/cli/src/cli/index.ts");

async function run(args: string[]) {
  const child = Bun.spawn(["bun", "run", cli, ...args], {
    cwd: import.meta.dir,
    env: { ...process.env, DEVVER_REDUCED_MOTION: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => {
    child.kill();
  }, 3000);
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { status, output: stdout + stderr };
  } finally {
    clearTimeout(timeout);
  }
}

test("bare devver and help spellings show command help without starting the TUI", async () => {
  for (const args of [[], ["--help"], ["-h"], ["help"]]) {
    const result = await run(args);
    expect(result.status).toBe(0);
    expect(result.output).toContain("SUBCOMMANDS");
    expect(result.output).toContain("tui");
  }
});

test("TUI help remains available without launching the view", async () => {
  for (const args of [
    ["tui", "--help"],
    ["tui", "-h"],
  ]) {
    const result = await run(args);
    expect(result.status).toBe(0);
    expect(result.output).toContain("Start the terminal UI");
  }
});
