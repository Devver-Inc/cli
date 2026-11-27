import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const cli = join(import.meta.dir, "../packages/cli/src/cli/index.ts");
const older = "75758c56-340d-44a2-a709-a52066752456";
const latest = "3e8aa51d-75b3-4c7e-9fca-1190e573fefb";

test("publish defaults to the latest deployment, preserves explicit IDs and fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "devver-publish-"));
  const requests: string[] = [];
  const bin = join(root, "bin");
  const browserLog = join(root, "browser.log");
  const browserFail = join(root, "browser-fail");
  let empty = false;
  let ready = true;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      requests.push(`${request.method} ${pathname}`);
      if (request.method === "GET" && pathname === "/api/v1/deployments") {
        return Response.json(
          empty
            ? []
            : [
                {
                  deploymentId: older,
                  createdAt: "2026-11-04T10:00:00.000Z",
                  status: "ready",
                  stage: null,
                },
                {
                  deploymentId: latest,
                  createdAt: "2026-11-04T11:00:00.000Z",
                  status: ready ? "ready" : "failed",
                  stage: ready ? null : "readiness",
                },
              ]
        );
      }
      if (
        request.method === "POST" &&
        (pathname === `/api/v1/deployments/${older}/public` ||
          pathname === `/api/v1/deployments/${latest}/public`)
      ) {
        return ready
          ? Response.json({ url: "https://preview.example.com" })
          : new Response("Only ready deployments can be published", {
              status: 500,
            });
      }
      return new Response(null, { status: 404 });
    },
  });
  const run = async (...args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, "run", cli, "publish", ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          XDG_DATA_HOME: root,
          XDG_CONFIG_HOME: root,
          XDG_CACHE_HOME: root,
          XDG_STATE_HOME: root,
          PATH: [bin, process.env.PATH].join(delimiter),
          DEVVER_BROWSER_LOG: browserLog,
          DEVVER_BROWSER_FAIL: browserFail,
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { status, output: stdout + stderr };
  };
  try {
    mkdirSync(bin);
    for (const opener of ["open", "xdg-open"]) {
      writeFileSync(
        join(bin, opener),
        '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$DEVVER_BROWSER_LOG"\ntest ! -e "$DEVVER_BROWSER_FAIL"\n',
        { mode: 0o755 }
      );
    }
    const config = join(root, "devver", "config");
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, "cli"),
      JSON.stringify({
        "local-target": {
          url: `http://127.0.0.1:${server.port}/api/v1`,
          instanceId: older,
          name: "test",
          serverVersion: "0.0.0",
          controlProtocolVersion: 1,
        },
      })
    );
    const defaultResult = await run();
    expect(defaultResult.status, defaultResult.output).toBe(0);
    expect(defaultResult.output).toContain(
      "Published: https://preview.example.com"
    );
    expect(requests.splice(0)).toEqual([
      "GET /api/v1/deployments",
      `POST /api/v1/deployments/${latest}/public`,
    ]);

    expect(existsSync(browserLog)).toBe(false);
    const opened = await run("--open");
    expect(opened.status, opened.output).toBe(0);
    expect(readFileSync(browserLog, "utf-8")).toBe(
      "https://preview.example.com\n"
    );
    requests.splice(0);

    const explicit = await run(older, "--open");
    expect(explicit.status, explicit.output).toBe(0);
    expect(requests.splice(0)).toEqual([
      `POST /api/v1/deployments/${older}/public`,
    ]);

    expect(readFileSync(browserLog, "utf-8").trim().split("\n")).toHaveLength(
      2
    );
    writeFileSync(browserFail, "");
    const browserFailure = await run("--open");
    expect(browserFailure.status, browserFailure.output).toBe(0);
    expect(browserFailure.output).toContain(
      "Could not open the public URL in a browser."
    );
    requests.splice(0);

    ready = false;
    const failedLatest = await run("--open");
    expect(failedLatest.status).not.toBe(0);
    expect(requests.splice(0)).toEqual([
      "GET /api/v1/deployments",
      `POST /api/v1/deployments/${latest}/public`,
    ]);

    empty = true;
    const noDeployments = await run("--open");
    expect(noDeployments.status).not.toBe(0);
    expect(noDeployments.output).toContain(
      "No deployments on the attached server"
    );
    expect(requests).toEqual(["GET /api/v1/deployments"]);
    expect(readFileSync(browserLog, "utf-8").trim().split("\n")).toHaveLength(
      3
    );
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
