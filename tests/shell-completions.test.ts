import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

test("Bash completes saved server names offline", () => {
  const directory = mkdtempSync(join(tmpdir(), "devver-completion-"));
  try {
    const instance = join(directory, "devver", "servers", "alpha");
    mkdirSync(instance, { recursive: true, mode: 0o700 });
    chmodSync(join(directory, "devver"), 0o700);
    chmodSync(join(directory, "devver", "servers"), 0o700);
    writeFileSync(
      join(instance, "identity.json"),
      JSON.stringify({
        instanceId: "aaffbbcc-1122-4433-8899-aabbccddeeff",
        name: "alpha",
      }),
      { mode: 0o600 }
    );
    const script = Bun.spawnSync(["bun", "run", cli, "--completions", "bash"]);
    expect(script.exitCode).toBe(0);
    const result = spawnSync(
      "bash",
      [
        "-c",
        `source /dev/stdin; devver() { bun run "$DEVVER_CLI" "$@"; }; COMP_WORDS=(devver server stop al); COMP_CWORD=3; COMP_LINE="devver server stop al"; COMP_POINT=\${#COMP_LINE}; _devver; declare -p COMPREPLY`,
      ],
      {
        input: script.stdout.toString(),
        encoding: "utf-8",
        env: { ...process.env, XDG_DATA_HOME: directory, DEVVER_CLI: cli },
      }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"alpha"');
    const deploymentId = "bbffbbcc-1122-4433-8899-aabbccddeeff";
    const config = join(directory, "devver", "config");
    mkdirSync(config, { recursive: true });
    const target = {
      name: "alpha",
      instanceId: "aaffbbcc-1122-4433-8899-aabbccddeeff",
      url: "http://127.0.0.1:49000/api/v1",
      serverVersion: "1.0.0",
      controlProtocolVersion: 1,
    };
    writeFileSync(
      join(config, "cli"),
      JSON.stringify({ "local-target": target })
    );
    const save = spawnSync(
      "bun",
      [
        "-e",
        `import { saveLocalDeployments } from "${join(repo, "packages/cli/src/cli/completion-cache.ts")}"; await saveLocalDeployments("${target.instanceId}", [{ deploymentId: "${deploymentId}", status: "ready" }, { deploymentId: "ccffbbcc-1122-4433-8899-aabbccddeeff", status: "degraded" }]);`,
      ],
      { encoding: "utf-8", env: { ...process.env, XDG_DATA_HOME: directory } }
    );
    expect(save.status, save.stderr).toBe(0);
    const merged = spawnSync(
      "bash",
      [
        "-c",
        'source /dev/stdin; devver() { bun run "$DEVVER_CLI" "$@"; }; COMP_WORDS=(devver merge bbf); COMP_CWORD=2; COMP_LINE="devver merge bbf"; _devver; declare -p COMPREPLY',
      ],
      {
        input: script.stdout.toString(),
        encoding: "utf-8",
        env: { ...process.env, XDG_DATA_HOME: directory, DEVVER_CLI: cli },
      }
    );
    expect(merged.status, merged.stderr).toBe(0);
    expect(merged.stdout).toContain(deploymentId);
    expect(merged.stdout).not.toContain("ccffbbcc-1122-4433-8899-aabbccddeeff");
    writeFileSync(
      join(config, "cli"),
      JSON.stringify({
        "local-target": {
          ...target,
          instanceId: "ccffbbcc-1122-4433-8899-aabbccddeeff",
        },
      })
    );
    const other = spawnSync(
      "bun",
      ["run", cli, "--completion-deployment-ids"],
      {
        encoding: "utf-8",
        env: { ...process.env, XDG_DATA_HOME: directory },
      }
    );
    expect(other.status, other.stderr).toBe(0);
    expect(other.stdout.trim()).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
