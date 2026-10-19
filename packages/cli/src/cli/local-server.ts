import { Console, Data, Effect, Schema, Stream } from "effect";
import { Argument, Command } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

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

class IdentityProbeError extends Data.TaggedError("IdentityProbeError")<{
  message: string;
}> {}

function probe(url: string) {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${url}/identity`).pipe(
        HttpClientRequest.setHeader("Accept", "application/json")
      )
    );
    if (response.status !== 200) {
      return yield* new IdentityProbeError({
        message: `Identity probe returned HTTP ${response.status}`,
      });
    }
    const bytes = yield* Stream.runFoldEffect(
      response.stream,
      () => Buffer.alloc(0),
      (acc, chunk) =>
        acc.length + chunk.length > MAX_IDENTITY_BYTES
          ? Effect.fail(
              new IdentityProbeError({
                message: "Identity response is too large",
              })
            )
          : Effect.succeed(Buffer.concat([acc, chunk]))
    );
    return yield* Effect.try({
      try: () =>
        decodeIdentity(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        ),
      catch: () =>
        new IdentityProbeError({
          message: "Server identity response is invalid",
        }),
    });
  }).pipe(
    Effect.timeout(2000),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(FetchHttpClient.layer),
    Effect.scoped
  );
}

export async function verifyIdentity(url: string) {
  validateControlUrl(url);
  const identity = await Effect.runPromise(probe(url));
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
      const config = await readConfig();
      const target = await verifyIdentity(url);
      const { "cloud-target": _removed, ...rest } = config;
      await writeConfig({ ...rest, "local-target": target });
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
    const {
      "local-target": _local,
      "cloud-target": _cloud,
      ...config
    } = await readConfig();
    await writeConfig(config);
  }).pipe(Effect.flatMap(() => Console.log("Detached target")))
).pipe(Command.withDescription("Clear the selected target"));

const status = Command.make("status", {}, () =>
  Effect.tryPromise(async () => {
    const config: CliConfig = await readConfig();
    const target = config["local-target"];
    if (target === undefined) {
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
      return `${target.name} (${target.instanceId}) at ${target.url} — version ${target.serverVersion}: ${reachability}`;
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
