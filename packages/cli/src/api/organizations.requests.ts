import { Effect, Schema } from "effect";

import { ApiClient } from "./client";
import type { ApiRequestError } from "./client";

export const Organization = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
});

export type OrganizationDto = typeof Organization.Type;

export const OrganizationList = Schema.Array(Organization);

export const getOrganization = (
  organizationId: string
): Effect.Effect<OrganizationDto, ApiRequestError, ApiClient> =>
  Effect.gen(function* () {
    const client = yield* ApiClient;
    return yield* client.get(`/organizations/${organizationId}`, Organization);
  });

export const getOrganizations = (
  organizationIds: string[]
): Effect.Effect<OrganizationDto[], ApiRequestError, ApiClient> =>
  Effect.forEach(organizationIds, (id) => getOrganization(id), {
    concurrency: "unbounded",
  });
