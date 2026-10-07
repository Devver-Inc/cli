import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigFile } from "../packages/cli/src/config";
import {
  readSecretsFile,
  setDeploymentEnv,
} from "../packages/cli/src/config/secrets";
import { idToken } from "./jwt";

const cliEntry = join(
  import.meta.dir,
  "..",
  "packages",
  "cli",
  "src",
  "cli",
  "index.ts"
);
const INVALID_YAML = /Invalid YAML/;
const INVALID_CONFIG = /Invalid devver config/;
const INVALID_SECRETS = /Invalid secrets file/;

function workspace() {
  return mkdtempSync(join(tmpdir(), "devver-trust-"));
}

test("devver.yaml is decoded, and malformed YAML is rejected instead of trusted", () => {
  const root = workspace();
  try {
    const configPath = join(root, ".devver.yaml");

    writeFileSync(
      configPath,
      "project: demo\nservices:\n  web:\n    build: bun run build\n    start: bun run start\nenv:\n  NODE_ENV: production\n"
    );
    const valid = readConfigFile(root);
    expect(valid?.project).toBe("demo");
    expect(valid?.services.web?.build).toBe("bun run build");
    expect(valid?.env?.NODE_ENV).toBe("production");

    expect(readConfigFile(join(root, "absent"))).toBeNull();

    writeFileSync(configPath, "project: demo\n  services: [oops\n");
    expect(() => readConfigFile(root)).toThrow(INVALID_YAML);

    writeFileSync(
      configPath,
      "project: demo\nservices:\n  web:\n    build: 7\n"
    );
    expect(() => readConfigFile(root)).toThrow(INVALID_CONFIG);

    writeFileSync(
      configPath,
      "services:\n  web:\n    build: x\n    start: y\n"
    );
    expect(() => readConfigFile(root)).toThrow(INVALID_CONFIG);

    writeFileSync(configPath, "just a string\n");
    expect(() => readConfigFile(root)).toThrow(INVALID_CONFIG);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secrets with a wrong shape are rejected and never overwritten", () => {
  const root = workspace();
  try {
    setDeploymentEnv("demo", { TOKEN: "s3cret" }, root);
    expect(readSecretsFile(root).demo?.env.TOKEN).toBe("s3cret");

    const secretsPath = join(root, ".devver", ".secrets");
    writeFileSync(secretsPath, "{not json");
    expect(() => readSecretsFile(root)).toThrow(INVALID_SECRETS);
    expect(() => setDeploymentEnv("demo", { A: "b" }, root)).toThrow(
      INVALID_SECRETS
    );
    expect(Bun.file(secretsPath).size).toBe("{not json".length);

    writeFileSync(secretsPath, JSON.stringify({ demo: { name: "demo" } }));
    expect(() => readSecretsFile(root)).toThrow(INVALID_SECRETS);

    writeFileSync(
      secretsPath,
      JSON.stringify({ demo: { name: "demo", env: { TOKEN: 1 } } })
    );
    expect(() => readSecretsFile(root)).toThrow(INVALID_SECRETS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function credentials(root: string, accessToken: string, idToken: string) {
  const data = join(root, "data", "devver");
  mkdirSync(join(data, "logto"), { recursive: true });
  mkdirSync(join(data, "auth"), { recursive: true });
  writeFileSync(join(data, "logto", "accessToken"), accessToken);
  writeFileSync(join(data, "logto", "idToken"), idToken);
  writeFileSync(join(data, "auth", "currentOrganization"), "org-1");
}

async function runCli(root: string, apiUrl: string) {
  const child = Bun.spawn(
    ["bun", "run", cliEntry, "project", "list", "--api-url", apiUrl],
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
}

test("a corrupt credential store fails without echoing the token", async () => {
  const root = workspace();
  const validToken = JSON.stringify({
    "@http://localhost:9999#org-1": {
      token: "do-not-print-me",
      scope: "",
      expiresAt: "not-a-number",
    },
  });
  credentials(root, validToken, idToken({ organizations: ["org-1"] }));
  try {
    const result = await runCli(root, "http://127.0.0.1:1/api/v1");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("access token");
    expect(result.output).not.toContain("do-not-print-me");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-JSON error body reports the status instead of crashing", async () => {
  const root = workspace();
  credentials(
    root,
    JSON.stringify({
      "@http://localhost:9999#org-1": {
        token: "local-only-token",
        scope: "",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    }),
    idToken({ sub: "user-1", organizations: ["org-1"] })
  );
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response("<html>bad gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
  });
  try {
    const result = await runCli(root, `${server.url.origin}/api/v1`);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("502");
    expect(result.output).not.toContain("local-only-token");
    expect(result.output).not.toContain("Defect");
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
