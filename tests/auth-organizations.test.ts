import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idToken } from "./jwt";

const repo = join(import.meta.dir, "..");

function probe(accessTokenClaims: string) {
  const root = mkdtempSync(join(tmpdir(), "devver-orgs-"));
  const data = join(root, "data", "devver");
  mkdirSync(join(data, "logto"), { recursive: true });
  writeFileSync(
    join(data, "logto", "idToken"),
    idToken({ organizations: ["org-1", "org-2"] })
  );
  const script = `
    import { mock } from "bun:test";
    mock.module("${join(repo, "src/auth/logto.ts")}", () => ({
      createLogtoClient: () => ({
        isAuthenticated: async () => true,
        getAccessTokenClaims: ${accessTokenClaims},
        getIdTokenClaims: async () => ({
          sub: "u1",
          organizations: ["org-1", "org-2"],
        }),
      }),
    }));
    const { getOrganizations } = await import("${join(repo, "src/auth/session.ts")}");
    console.log(JSON.stringify(await getOrganizations()));
  `;
  try {
    const result = Bun.spawnSync(["bun", "-e", script], {
      cwd: repo,
      env: {
        ...process.env,
        XDG_DATA_HOME: join(root, "data"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(`probe failed: ${result.stderr.toString()}`);
    }
    const lines = result.stdout.toString().trim().split("\n");
    return JSON.parse(lines.at(-1) ?? "null");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const fromIdToken = [
  { id: "org-1", name: "org-1" },
  { id: "org-2", name: "org-2" },
];

test("organizations fall back to the ID token when access token claims fail", () => {
  expect(
    probe('async () => { throw new Error("no resource token"); }')
  ).toEqual(fromIdToken);
});

test("organizations fall back when access token claims carry none", () => {
  expect(probe("async () => ({ organizations: [] })")).toEqual(fromIdToken);
  expect(probe("async () => ({})")).toEqual(fromIdToken);
});

test("organizations keep provider names when access token claims carry them", () => {
  expect(
    probe('async () => ({ organizations: [{ id: "org-1", name: "Primary" }] })')
  ).toEqual([{ id: "org-1", name: "Primary" }]);
});
