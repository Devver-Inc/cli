import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idToken } from "./jwt";

const entry = join(import.meta.dir, "..", "src", "cli", "index.ts");

test("one scoped API layer uses selected credentials and reports HTTP failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "devver-api-"));
  const data = join(root, "data", "devver");
  mkdirSync(join(data, "logto"), { recursive: true });
  mkdirSync(join(data, "auth"), { recursive: true });
  writeFileSync(
    join(data, "logto", "accessToken"),
    JSON.stringify({
      "@http://localhost:9999#org-1": {
        token: "local-only-token",
        scope: "",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    })
  );
  writeFileSync(
    join(data, "logto", "idToken"),
    idToken({ sub: "user-1", organizations: ["org-1"] })
  );
  writeFileSync(join(data, "auth", "currentOrganization"), "org-1");

  let fail = false;
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests++;
      expect(request.headers.get("authorization")).toBe(
        "Bearer local-only-token"
      );
      expect(new URL(request.url).pathname).toBe("/api/v1/projects");
      if (fail) {
        return Response.json(
          { statusCode: 503, message: "BACKEND_DOWN" },
          { status: 503 }
        );
      }
      return Response.json({
        id: "p1",
        name: "demo",
        description: null,
        createdAt: new Date().toISOString(),
      });
    },
  });
  const run = async () => {
    const child = Bun.spawn(
      [
        "bun",
        "run",
        entry,
        "project",
        "create",
        "demo",
        "--api-url",
        `${server.url.origin}/api/v1`,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          XDG_DATA_HOME: join(root, "data"),
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_CACHE_HOME: join(root, "cache"),
          XDG_STATE_HOME: join(root, "state"),
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [status, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { status, output: `${out}${err}` };
  };
  try {
    const success = await run();
    expect(success.status, success.output).toBe(0);
    expect(success.output).toContain("Project ID: p1");
    expect(success.output).not.toContain("local-only-token");
    fail = true;
    const failure = await run();
    expect(failure.status).not.toBe(0);
    expect(failure.output).toContain("BACKEND_DOWN");
    expect(requests).toBe(2);
    writeFileSync(join(data, "auth", "currentOrganization"), "invalid");
    const invalidOrg = await run();
    expect(invalidOrg.status).not.toBe(0);
    expect(invalidOrg.output).toContain(
      "Selected organization 'invalid' is unavailable"
    );
    expect(requests).toBe(2);
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
