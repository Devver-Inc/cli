/**
 * Local secrets manager for deployment-specific environment variables.
 *
 * Inspired by Kamal's `.kamal/secrets` pattern:
 *   - Project-level env vars live in `devver.yml` under `env:`.
 *   - Deployment-specific (secret) env vars live in `.devver/.secrets`,
 *     keyed by deployment name or ID.
 *
 * When constructing a deploy request, secrets are merged on top of
 * project-level env — deployment-specific values take priority.
 *
 * The `.secrets` file is a JSON file and MUST be added to `.gitignore`.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cwd } from "node:process";
import { Schema } from "effect";

const DeploymentSecretsSchema = Schema.Struct({
  name: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
});

const SecretsFileSchema = Schema.Record(Schema.String, DeploymentSecretsSchema);

export type DeploymentSecrets = typeof DeploymentSecretsSchema.Type;
export type SecretsFile = typeof SecretsFileSchema.Type;

const decodeSecretsFile = Schema.decodeUnknownSync(SecretsFileSchema);

const DEVVER_DIR = ".devver";
const SECRETS_FILE = ".secrets";

function secretsFilePath(root?: string): string {
  const dir = root ?? cwd();
  return path.join(dir, DEVVER_DIR, SECRETS_FILE);
}

function ensureDevverDir(root?: string): void {
  const dir = path.join(root ?? cwd(), DEVVER_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    fs.chmodSync(dir, 0o700);
  }
}

export function readSecretsFile(root?: string): SecretsFile {
  const filePath = secretsFilePath(root);
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const content = fs.readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid secrets file: ${filePath}`, { cause: error });
  }
  try {
    return decodeSecretsFile(parsed);
  } catch (error) {
    throw new Error(`Invalid secrets file: ${filePath}`, { cause: error });
  }
}

export function writeSecretsFile(secrets: SecretsFile, root?: string): void {
  readSecretsFile(root);
  ensureDevverDir(root);
  const filePath = secretsFilePath(root);
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(secrets, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
}

export function getDeploymentEnv(
  deploymentKey: string,
  root?: string
): Record<string, string> {
  const secrets = readSecretsFile(root);
  return secrets[deploymentKey]?.env ?? {};
}

export function setDeploymentEnv(
  deploymentKey: string,
  env: Record<string, string>,
  root?: string
): void {
  const secrets = readSecretsFile(root);
  const existing = secrets[deploymentKey]?.env ?? {};
  writeSecretsFile(
    {
      ...secrets,
      [deploymentKey]: {
        name: deploymentKey,
        env: { ...existing, ...env },
      },
    },
    root
  );
}

export function removeDeploymentEnvKey(
  deploymentKey: string,
  envKey: string,
  root?: string
): void {
  const secrets = readSecretsFile(root);
  const deployment = secrets[deploymentKey];
  if (!deployment) {
    return;
  }
  const { [envKey]: _removed, ...env } = deployment.env;
  if (Object.keys(env).length === 0) {
    removeDeployment(deploymentKey, root);
    return;
  }
  writeSecretsFile(
    { ...secrets, [deploymentKey]: { name: deployment.name, env } },
    root
  );
}

export function removeDeployment(deploymentKey: string, root?: string): void {
  const { [deploymentKey]: _removed, ...rest } = readSecretsFile(root);
  writeSecretsFile(rest, root);
}

export function listDeploymentSecrets(root?: string): DeploymentSecrets[] {
  const secrets = readSecretsFile(root);
  return Object.values(secrets);
}

export function mergeEnv(
  projectEnv: Record<string, string>,
  deploymentEnv: Record<string, string>
): Record<string, string> {
  return { ...projectEnv, ...deploymentEnv };
}
