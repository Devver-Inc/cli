/**
 * Persistent CLI configuration stored in the XDG data directory.
 *
 * Config keys are simple strings (e.g. "api-url") mapped to string values.
 * The primary use-case right now is storing the API base URL so that
 * `devver config set api-url http://localhost:3000/api/v1` persists across
 * invocations without requiring env vars or flags every time.
 *
 * Resolution order for the API URL:
 *   1. `--api-url` flag               (highest priority)
 *   2. Stored config (`devver config set api-url`)
 *   3. `DEVVER_API_URL` env var (or .env file)
 *   4. Hardcoded fallback               (lowest priority)
 */

import { Schema } from "effect";
import { Storage } from "../storage";

const CONTROL_URL = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/api\/v1$/;

export function validateControlUrl(input: string): string {
  const match = CONTROL_URL.exec(input);
  if (!match || Number(match[1]) > 65_535) {
    throw new Error(
      "Control URL must be http://127.0.0.1:<port>/api/v1 (no credentials, query or fragment)"
    );
  }
  return input;
}

export const InstanceNameSchema = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
);

export const LocalTargetSchema = Schema.Struct({
  url: Schema.String,
  instanceId: Schema.String.check(Schema.isUUID(4)),
  name: InstanceNameSchema,
  serverVersion: Schema.String,
  controlProtocolVersion: Schema.Literal(1),
});

export const CliConfigSchema = Schema.Struct({
  "api-url": Schema.optional(Schema.String),
  "local-target": Schema.optional(LocalTargetSchema),
});

export type CliConfig = typeof CliConfigSchema.Type;

const decodeCliConfig = Schema.decodeUnknownSync(CliConfigSchema);

const CONFIG_KEY = "config/cli";

export async function readConfig(): Promise<CliConfig> {
  const exists = await Storage.fileExists(CONFIG_KEY);
  if (!exists) {
    return {};
  }
  const raw = await Storage.readToString(CONFIG_KEY);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`CLI config at '${CONFIG_KEY}' is not valid JSON`);
  }
  try {
    const config = decodeCliConfig(parsed);
    if (config["local-target"]) {
      validateControlUrl(config["local-target"].url);
    }
    return config;
  } catch {
    throw new Error(`CLI config at '${CONFIG_KEY}' has an unexpected shape`);
  }
}

export async function writeConfig(config: CliConfig): Promise<void> {
  await Storage.write(CONFIG_KEY, JSON.stringify(config, null, 2));
}

export async function getConfigValue<K extends keyof CliConfig>(
  key: K
): Promise<CliConfig[K] | undefined> {
  const config = await readConfig();
  return config[key];
}

export async function setConfigValue<K extends keyof CliConfig>(
  key: K,
  value: CliConfig[K]
): Promise<void> {
  const config = await readConfig();
  await writeConfig({ ...config, [key]: value });
}

export async function unsetConfigValue<K extends keyof CliConfig>(
  key: K
): Promise<void> {
  const { [key]: _removed, ...rest } = await readConfig();
  await writeConfig(rest);
}

/**
 * Fallback API URL — only used when no config and no env var is set.
 * DEVVER_API_URL in .env is intended to be the actual default.
 */
const FALLBACK_API_URL = "https://app.devver.app/api/v1";

export async function resolveApiUrl(
  explicitOverride?: string
): Promise<string> {
  if (explicitOverride) {
    return explicitOverride;
  }

  const storedUrl = await getConfigValue("api-url");
  if (storedUrl) {
    return storedUrl;
  }

  const envUrl = process.env.DEVVER_API_URL;
  if (envUrl) {
    return envUrl;
  }

  return FALLBACK_API_URL;
}
