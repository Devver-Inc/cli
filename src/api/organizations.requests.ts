import { Effect, Schema } from "effect";
import { ApiClient, type ApiRequestError } from "./client";

export const Organization = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
});

export type Organization = Schema.Schema.Type<typeof Organization>;

export const OrganizationList = Schema.Array(Organization);

export const getOrganization = (
  organizationId: string
): Effect.Effect<Organization, ApiRequestError, ApiClient> =>
  Effect.gen(function* () {
    const client = yield* ApiClient;
    return yield* client.get(`/organizations/${organizationId}`, Organization);
  });

export const getOrganizations = (
  organizationIds: string[]
): Effect.Effect<Organization[], ApiRequestError, ApiClient> =>
  Effect.gen(function* () {
    const organizations = yield* Effect.all(
      organizationIds.map((id) => getOrganization(id)),
      { concurrency: "unbounded" }
    );
    return organizations;
  });
