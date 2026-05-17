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

import fs from "node:fs";
import path from "node:path";
import { cwd } from "node:process";


export interface DeploymentSecrets {
  name: string;
  env: Record<string, string>;
}

export type SecretsFile = Record<string, DeploymentSecrets>;


const DEVVER_DIR = ".devver";
const SECRETS_FILE = ".secrets";

function secretsFilePath(root?: string): string {
  const dir = root ?? cwd();
  return path.join(dir, DEVVER_DIR, SECRETS_FILE);
}

function ensureDevverDir(root?: string): void {
  const dir = path.join(root ?? cwd(), DEVVER_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}


export function readSecretsFile(root?: string): SecretsFile {
  const filePath = secretsFilePath(root);
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as SecretsFile;
  } catch {
    return {};
  }
}

export function writeSecretsFile(secrets: SecretsFile, root?: string): void {
  ensureDevverDir(root);
  const filePath = secretsFilePath(root);
  fs.writeFileSync(filePath, `${JSON.stringify(secrets, null, 2)}\n`);
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
  secrets[deploymentKey] = {
    name: deploymentKey,
    env: { ...existing, ...env },
  };
  writeSecretsFile(secrets, root);
}

export function removeDeploymentEnvKey(
  deploymentKey: string,
  envKey: string,
  root?: string
): void {
  const secrets = readSecretsFile(root);
  if (secrets[deploymentKey]) {
    delete secrets[deploymentKey].env[envKey];
    if (Object.keys(secrets[deploymentKey].env).length === 0) {
      delete secrets[deploymentKey];
    }
    writeSecretsFile(secrets, root);
  }
}

export function removeDeployment(
  deploymentKey: string,
  root?: string
): void {
  const secrets = readSecretsFile(root);
  delete secrets[deploymentKey];
  writeSecretsFile(secrets, root);
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
