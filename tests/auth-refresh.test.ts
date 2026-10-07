import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idToken } from "./jwt";

const repo = join(import.meta.dir, "..");

function session(expiresAt: number) {
  const root = mkdtempSync(join(tmpdir(), "devver-refresh-"));
  const data = join(root, "data", "devver");
  mkdirSync(join(data, "logto"), { recursive: true });
  mkdirSync(join(data, "auth"), { recursive: true });
  writeFileSync(join(data, "auth", "currentOrganization"), "org-1");
  writeFileSync(
    join(data, "logto", "idToken"),
    idToken({ sub: "user-1", organizations: ["org-1"] })
  );
  writeFileSync(
    join(data, "logto", "accessToken"),
    JSON.stringify({
      "@http://localhost:9999#org-1": {
        token: "stored-token",
        scope: "",
        expiresAt,
      },
    })
  );
  return root;
}

function probe(root: string, body: string) {
  const script = `
    import { mock } from "bun:test";
    let refreshes = 0;
    let failRefresh = false;
    const fake = {
      isAuthenticated: async () => true,
      getAccessTokenClaims: async () => ({
        organizations: [{ id: "org-1", name: "Demo" }],
      }),
      getIdTokenClaims: async () => ({ sub: "user-1", organizations: ["org-1"] }),
      getAccessToken: async () => {
        refreshes++;
        if (failRefresh) throw new Error("refresh failed");
        return "refreshed-token";
      },
      signOut: async () => {},
    };
    mock.module(${JSON.stringify(join(repo, "src/auth/logto.ts"))}, () => ({
      createLogtoClient: () => fake,
    }));
    const { getAccessToken } = await import(${JSON.stringify(join(repo, "src/auth/client.ts"))});
    const failure = async (work) => {
      try { await work(); return null; } catch (error) { return error.message; }
    };
    ${body}
  `;
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
}

test("a valid stored token is used without contacting the provider", () => {
  const root = session(Math.floor(Date.now() / 1000) + 3600);
  try {
    const result = probe(
      root,
      "console.log(JSON.stringify({ token: await getAccessToken(), refreshes }));"
    );
    expect(result).toEqual({ token: "stored-token", refreshes: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an expired stored token refreshes, and refresh failures propagate", () => {
  const root = session(Math.floor(Date.now() / 1000) - 60);
  try {
    const result = probe(
      root,
      `
      const token = await getAccessToken();
      failRefresh = true;
      const message = await failure(() => getAccessToken());
      console.log(JSON.stringify({ token, message, refreshes }));
      `
    );
    expect(result).toEqual({
      token: "refreshed-token",
      message: "refresh failed",
      refreshes: 2,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unavailable selected organization fails before any refresh", () => {
  const root = session(Math.floor(Date.now() / 1000) - 60);
  writeFileSync(
    join(root, "data", "devver", "auth", "currentOrganization"),
    "org-missing"
  );
  try {
    const result = probe(
      root,
      "console.log(JSON.stringify({ message: await failure(getAccessToken), refreshes }));"
    );
    expect(result.message).toContain(
      "Selected organization 'org-missing' is unavailable"
    );
    expect(result.refreshes).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
