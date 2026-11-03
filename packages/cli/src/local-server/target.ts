import { Data, Effect, Schema } from "effect";

import pkg from "../../../../package.json" with { type: "json" };
import {
  InstanceNameSchema,
  LocalTargetSchema,
  readConfig,
  validateControlUrl,
  writeConfig,
} from "../config/api";
import { fetchJson } from "../util/http";

const IdentitySchema = Schema.Struct({
  instanceId: Schema.String.check(Schema.isUUID(4)),
  name: InstanceNameSchema,
  serverVersion: Schema.String,
  controlProtocolVersion: Schema.Literal(1),
});
const decodeTarget = Schema.decodeUnknownSync(LocalTargetSchema);
const MAX_IDENTITY_BYTES = 8192;

class IdentityProbeError extends Data.TaggedError("IdentityProbeError")<{
  message: string;
}> {}

const probe = (url: string) =>
  fetchJson({
    url: `${url}/identity`,
    schema: IdentitySchema,
    limit: MAX_IDENTITY_BYTES,
    timeout: 2000,
    onError: (message) => new IdentityProbeError({ message }),
  });

export const identityAt = (url: string) =>
  Effect.gen(function* () {
    yield* Effect.try(() => validateControlUrl(url));
    const identity = yield* probe(url);
    if (identity.serverVersion !== pkg.version) {
      return yield* new IdentityProbeError({
        message: `Incompatible server version (expected ${pkg.version})`,
      });
    }
    return yield* Effect.try(() => decodeTarget({ url, ...identity }));
  });

export async function verifyIdentity(url: string) {
  return await Effect.runPromise(identityAt(url));
}

export const attachTarget = (url: string) =>
  Effect.gen(function* () {
    const config = yield* Effect.tryPromise(readConfig);
    const target = yield* identityAt(url);
    const { "cloud-target": _removed, ...rest } = config;
    yield* Effect.tryPromise(async () =>
      writeConfig({ ...rest, "local-target": target })
    );
    return target;
  });
