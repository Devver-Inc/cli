/**
 * Persistent CLI configuration stored in the XDG data directory.
 *
 * Config stores the selected local or official cloud target and the legacy
 * api-url setting. Neither the stored api-url nor DEVVER_API_URL selects a target.
 */

import { Schema } from "effect";

import { Storage } from "../storage";

export const CLOUD_API_URL = "https://app.devver.app/api/v1";

const CONTROL_URL = /^http:\/\/127\.0\.0\.1:(?<port>[1-9]\d{0,4})\/api\/v1$/u;

export function validateControlUrl(input: string): string {
  const match = CONTROL_URL.exec(input);
  if (match === null || Number(match.groups?.port) > 65_535) {
    throw new Error(
      "Control URL must be http://127.0.0.1:<port>/api/v1 (no credentials, query or fragment)"
    );
  }
  return input;
}

export const InstanceNameSchema = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u)
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
  "cloud-target": Schema.optional(Schema.Literal(true)),
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
    const target = config["local-target"];
    if (target !== undefined) {
      validateControlUrl(target.url);
      if (config["cloud-target"] === true) {
        throw new Error("Conflicting CLI targets");
      }
    }
    return config;
  } catch {
    throw new Error(`CLI config at '${CONFIG_KEY}' has an unexpected shape`);
  }
}

export async function writeConfig(config: CliConfig): Promise<void> {
  await Storage.write(CONFIG_KEY, JSON.stringify(config, null, 2));
}

export async function getConfigValue(
  key: "api-url"
): Promise<string | undefined> {
  const config = await readConfig();
  return config[key];
}

export async function unsetConfigValue(key: keyof CliConfig): Promise<void> {
  const { [key]: _removed, ...rest } = await readConfig();
  await writeConfig(rest);
}
