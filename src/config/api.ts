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

import { Storage } from "../storage";

export interface CliConfig {
  "api-url"?: string;
}

const CONFIG_KEY = "config/cli";


export async function readConfig(): Promise<CliConfig> {
  const exists = await Storage.fileExists(CONFIG_KEY);
  if (!exists) {
    return {};
  }
  try {
    const raw = await Storage.readToString(CONFIG_KEY);
    return JSON.parse(raw) as CliConfig;
  } catch {
    return {};
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
  config[key] = value;
  await writeConfig(config);
}

export async function unsetConfigValue<K extends keyof CliConfig>(
  key: K
): Promise<void> {
  const config = await readConfig();
  delete config[key];
  await writeConfig(config);
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
