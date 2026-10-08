import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import pkg from "../../../package.json" with { type: "json" };
import { api, CONTROL_PROTOCOL_VERSION } from "./api";
import type { loadInstance } from "./identity";

type Instance = Awaited<ReturnType<typeof loadInstance>>;

export const instanceHandlers = (instance: Instance) =>
  HttpApiBuilder.group(api, "instance", (handlers) =>
    handlers.handle("identity", () =>
      Effect.succeed({
        instanceId: instance.instanceId,
        name: instance.name,
        serverVersion: pkg.version,
        controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
      })
    )
  );
