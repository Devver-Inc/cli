import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const cli = join(repo, "packages/cli/src/cli/index.ts");

for (const shell of ["bash", "zsh", "fish"] as const) {
  test(`generates ${shell} completions without starting the TUI`, () => {
    const result = Bun.spawnSync(["bun", "run", cli, "--completions", shell], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const script = result.stdout.toString();
    for (const entry of ["attach", "deploy", "server", "tui", "--api-url"]) {
      expect(script).toContain(entry);
    }
    if (shell === "bash" || shell === "zsh") {
      const parsed = spawnSync(shell, ["-n"], {
        input: script,
        encoding: "utf-8",
      });
      expect(parsed.status, parsed.stderr).toBe(0);
    }
    if (shell === "bash") {
      const completed = spawnSync(
        "bash",
        [
          "-c",
          'source /dev/stdin; COMP_WORDS=(devver dep); COMP_CWORD=1; COMP_LINE="devver dep"; COMP_POINT=10; _devver; declare -p COMPREPLY',
        ],
        { input: script, encoding: "utf-8" }
      );
      expect(completed.status, completed.stderr).toBe(0);
      expect(completed.stdout).toContain('[0]="deploy"');
    }
    if (shell === "fish" && Bun.which("fish") !== null) {
      const parsed = spawnSync("fish", ["-n"], {
        input: script,
        encoding: "utf-8",
      });
      expect(parsed.status, parsed.stderr).toBe(0);
    }
  });
}

test("the release formula installs scripts for each supported shell", () => {
  const workflow = readFileSync(
    join(repo, ".github/workflows/release.yml"),
    "utf-8"
  );
  expect(workflow).toContain(
    'generate_completions_from_executable(bin/"devver", shell_parameter_format: "--completions=", shells: [:bash, :zsh, :fish])'
  );
  for (const file of [
    'bash_completion/"devver"',
    'zsh_completion/"_devver"',
    'fish_completion/"devver.fish"',
  ]) {
    expect(workflow).toContain(file);
  }
});
