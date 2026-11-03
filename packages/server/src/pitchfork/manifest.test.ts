import { expect, test } from "bun:test";

import type { DaemonSpec } from "./manifest";
import { manifestText, projectLabel, safeDeploymentId } from "./manifest";

const id = "11111111-2222-4333-8444-555555555555";

const spec: DaemonSpec = {
  command: ["npm", "run", "dev"],
  dir: "/tmp/instance/worktrees/site",
  env: { PORT: "4001", HOST: "127.0.0.1" },
  port: 4001,
};

test.skipIf(process.platform === "win32")(
  "a daemon entry pins its port, keeps the instance directory and changes into the workload",
  () => {
    expect(
      manifestText({
        daemons: new Map([[id, spec]]),
        instanceDirectory: "/tmp/instance",
        proxyPort: 4000,
      })
    ).toBe(
      `[settings.proxy]
enable = true
https = false
port = 4000
auto_trust = false
sync_hosts = false
dns = false
tld = "localhost"
host = "127.0.0.1"

[daemons."${id}"]
run = 'cd "/tmp/instance/worktrees/site" && PORT="4001" HOST="127.0.0.1" "npm" "run" "dev"'
dir = '/tmp/instance'
port = { expect = [4001], bump = false }
`
    );
  }
);

test("a manifest without a proxy port carries no proxy settings", () => {
  expect(
    manifestText({
      daemons: new Map(),
      instanceDirectory: "/tmp/instance",
      proxyPort: 0,
    })
  ).toBe("\n");
});

test.skipIf(process.platform === "win32")(
  "a workload without environment variables runs its command directly",
  () => {
    expect(
      manifestText({
        daemons: new Map([
          [id, { command: spec.command, dir: spec.dir, port: spec.port }],
        ]),
        instanceDirectory: "/tmp/instance",
        proxyPort: 0,
      })
    ).toContain(
      `run = 'cd "/tmp/instance/worktrees/site" && "npm" "run" "dev"'`
    );
  }
);

test("command, path and environment injection attempts are rejected", () => {
  const rejected = [
    { ...spec, command: ["npm", 'x" && rm -rf /; echo "'] },
    { ...spec, command: ["npm", "$(whoami)"] },
    { ...spec, dir: '/tmp/"evil' },
    { ...spec, env: { "PORT; echo": "4001" } },
    { ...spec, env: { PORT: "4001\nenable = false" } },
  ];
  for (const daemon of rejected) {
    expect(() =>
      manifestText({
        daemons: new Map([[id, daemon]]),
        instanceDirectory: "/tmp/instance",
        proxyPort: 4000,
      })
    ).toThrow();
  }
});

test("an instance directory cannot break out of its own TOML literal", () => {
  expect(() =>
    manifestText({
      daemons: new Map([[id, spec]]),
      instanceDirectory: "/tmp/in'stance\nenable = false",
      proxyPort: 4000,
    })
  ).toThrow("A deployment path cannot contain");
});

test("only a version 4 UUID can name a daemon", () => {
  expect(safeDeploymentId(id)).toBe(id);
  for (const invalid of [
    "../escape",
    "",
    "11111111-2222-1333-8444-555555555555",
  ]) {
    expect(() => safeDeploymentId(invalid)).toThrow(
      "A deployment name must be a UUID"
    );
  }
});

test("a project label stays within Pitchfork's limit and drops separators", () => {
  expect(projectLabel("/tmp/My_Server-")).toBe("my-server");
  expect(projectLabel(`/tmp/${"a".repeat(80)}`)).toHaveLength(63);
});
