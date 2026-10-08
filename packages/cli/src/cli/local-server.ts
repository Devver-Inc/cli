import { Console, Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";

import pkg from "../../../../package.json" with { type: "json" };
import { listInstances, readInstanceService } from "../../../server/identity";
import {
  InstanceNameSchema,
  LocalTargetSchema,
  readConfig,
  validateControlUrl,
  writeConfig,
} from "../config/api";
import type { CliConfig } from "../config/api";

const IdentitySchema = Schema.Struct({
  instanceId: Schema.String.check(Schema.isUUID(4)),
  name: InstanceNameSchema,
  serverVersion: Schema.String,
  controlProtocolVersion: Schema.Literal(1),
});
const decodeIdentity = Schema.decodeUnknownSync(IdentitySchema);
const decodeTarget = Schema.decodeUnknownSync(LocalTargetSchema);
const MAX_IDENTITY_BYTES = 8192;

async function probe(url: string) {
  const response = await fetch(`${url}/identity`, {
    redirect: "manual",
    signal: AbortSignal.timeout(2000),
    headers: { Accept: "application/json" },
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`Identity probe returned HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Identity response has no body");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.length;
      if (size > MAX_IDENTITY_BYTES) {
        throw new Error("Identity response is too large");
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The peer may have already closed the response stream.
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return decodeIdentity(data);
  } catch {
    throw new Error("Server identity response is invalid");
  }
}

export async function verifyIdentity(url: string) {
  validateControlUrl(url);
  const identity = await probe(url);
  if (identity.serverVersion !== pkg.version) {
    throw new Error(`Incompatible server version (expected ${pkg.version})`);
  }
  return decodeTarget({ url, ...identity });
}

export const attach = Command.make(
  "attach",
  { url: Argument.String("url") },
  ({ url }) =>
    Effect.tryPromise(async () => {
      // Read first: malformed stored state must never be overwritten by a new attachment.
      const config = await readConfig();
      const target = await verifyIdentity(url);
      await writeConfig({ ...config, "local-target": target });
      return target;
    }).pipe(
      Effect.flatMap((target) =>
        Console.log(
          `Attached ${target.name} (${target.instanceId}) at ${target.url} — version ${target.serverVersion}`
        )
      )
    )
).pipe(Command.withDescription("Attach to a verified local server"));

export const detach = Command.make("detach", {}, () =>
  Effect.tryPromise(async () => {
    const { "local-target": _removed, ...config } = await readConfig();
    await writeConfig(config);
  }).pipe(Effect.flatMap(() => Console.log("Detached local server")))
).pipe(Command.withDescription("Clear the local server selection"));

const status = Command.make("status", {}, () =>
  Effect.tryPromise(async () => {
    const config: CliConfig = await readConfig();
    const target = config["local-target"];
    if (!target) {
      return "No server attached";
    }
    let reachability = "unreachable";
    try {
      const current = await verifyIdentity(target.url);
      if (
        current.instanceId === target.instanceId &&
        current.name === target.name
      ) {
        reachability = "reachable";
      }
    } catch {
      // A stopped or changed server does not remove the saved selection.
    }
    return `${target.name} (${target.instanceId}) at ${target.url} — version ${target.serverVersion}: ${reachability}`;
  }).pipe(Effect.flatMap((message) => Console.log(message)))
);

async function instanceReachability(
  url: string,
  name: string,
  instanceId: string,
  serverVersion: string
) {
  try {
    const current = await verifyIdentity(url);
    if (current.name !== name || current.instanceId !== instanceId) {
      return "mismatched identity";
    }
    return current.serverVersion === serverVersion
      ? "reachable"
      : "mismatched version";
  } catch (error) {
    return error instanceof Error &&
      error.message.startsWith("Incompatible server version")
      ? "incompatible"
      : "unreachable";
  }
}

const list = Command.make("list", {}, () =>
  Effect.tryPromise(async () => {
    const config = await readConfig();
    const instances = await listInstances();
    if (instances.length === 0) {
      return "No server instances found";
    }
    const lines: string[] = [];
    for (const instance of instances) {
      const service = await readInstanceService(instance.name);
      const url = `http://127.0.0.1:${service.port}/api/v1`;
      const reachability = await instanceReachability(
        url,
        instance.name,
        instance.instanceId,
        service.serverVersion
      );
      const target = config["local-target"];
      const selected =
        target?.name === instance.name &&
        target.instanceId === instance.instanceId &&
        target.url === url
          ? " [selected]"
          : "";
      lines.push(
        `${instance.name} (${instance.instanceId}) at ${url} — version ${service.serverVersion}: ${reachability}${selected}`
      );
    }
    return lines.join("\n");
  }).pipe(Effect.flatMap((message) => Console.log(message)))
).pipe(Command.withDescription("List saved local server instances"));

export const server = Command.make("server").pipe(
  Command.withDescription("Inspect local server instances"),
  Command.withSubcommands([status, list])
);
