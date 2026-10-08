import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";

export const CONTROL_PROTOCOL_VERSION = 1;

export const API_PATH = "/api/v1";

export const IdentityResponse = Schema.Struct({
  instanceId: Schema.String,
  name: Schema.String,
  serverVersion: Schema.String,
  controlProtocolVersion: Schema.Literal(CONTROL_PROTOCOL_VERSION),
});

export const api = HttpApi.make("DevverControl").add(
  HttpApiGroup.make("instance")
    .add(
      HttpApiEndpoint.get("identity", "/identity", {
        success: HttpApiSchema.WithHeaders(IdentityResponse, {
          "cache-control": Schema.Literal("no-store"),
        }),
      })
    )
    .prefix(API_PATH)
);
