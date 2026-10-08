import { Schema } from "effect";

import { Storage } from "../storage";
import { getCurrentOrganization } from "./organization";
import { API_RESOURCE, getAccessTokenFor, getOrganizations } from "./session";
import type { Organization } from "./session";

const TOKEN_EXPIRY_BUFFER_SECONDS = 60;

const StoredTokensSchema = Schema.Record(
  Schema.String,
  Schema.Struct({
    token: Schema.String,
    expiresAt: Schema.Number,
    scope: Schema.optional(Schema.String),
  })
);

const IdTokenClaimsSchema = Schema.Struct({
  organizations: Schema.optional(Schema.Array(Schema.String)),
});

const decodeStoredTokens = Schema.decodeUnknownSync(StoredTokensSchema);
const decodeIdTokenClaims = Schema.decodeUnknownSync(IdTokenClaimsSchema);

export type OrganizationDetails = Organization;

function decodeStoredAccessTokens(content: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(
      "Stored access token is not valid JSON. Please log in again."
    );
  }
  try {
    return decodeStoredTokens(parsed);
  } catch {
    throw new Error(
      "Stored access token has an unexpected shape. Please log in again."
    );
  }
}

function decodeJwtClaims(token: string) {
  const [, payload] = token.split(".");
  if (payload === undefined || payload === "") {
    throw new Error("Stored ID token is not a JWT. Please log in again.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
  } catch {
    throw new Error(
      "Stored ID token has an unreadable payload. Please log in again."
    );
  }
  try {
    return decodeIdTokenClaims(parsed);
  } catch {
    throw new Error(
      "Stored ID token has an unexpected shape. Please log in again."
    );
  }
}

async function getStoredOrganizationIds(): Promise<readonly string[]> {
  if (!(await Storage.fileExists("logto/idToken"))) {
    return [];
  }
  const content = (await Storage.readToString("logto/idToken")).trim();
  const claims = decodeJwtClaims(content);
  return claims.organizations ?? [];
}

async function getStoredToken(): Promise<string | null> {
  if (!(await Storage.fileExists("logto/accessToken"))) {
    return null;
  }
  const content = await Storage.readToString("logto/accessToken");
  const tokens = decodeStoredAccessTokens(content);
  const organizationIds = await getStoredOrganizationIds();

  const currentOrg = await getCurrentOrganization();
  if (
    currentOrg !== null &&
    currentOrg !== "" &&
    !organizationIds.includes(currentOrg)
  ) {
    throw new Error(`Selected organization '${currentOrg}' is unavailable`);
  }
  const orgId = currentOrg ?? organizationIds[0];
  if (orgId === undefined || orgId === "") {
    return null;
  }

  const entry = tokens[`@${API_RESOURCE}#${orgId}`];
  if (entry === undefined) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  return entry.expiresAt > now + TOKEN_EXPIRY_BUFFER_SECONDS
    ? entry.token
    : null;
}

async function refreshToken(): Promise<string | null> {
  const currentOrg = await getCurrentOrganization();
  if (currentOrg !== null && currentOrg !== "") {
    const organizations = await getOrganizations();
    if (!organizations.some((org) => org.id === currentOrg)) {
      throw new Error(`Selected organization '${currentOrg}' is unavailable`);
    }
  }
  return await getAccessTokenFor(currentOrg ?? undefined);
}

export async function getAccessToken(): Promise<string | null> {
  const storedToken = await getStoredToken();
  if (storedToken !== null && storedToken !== "") {
    return storedToken;
  }
  return await refreshToken();
}

export async function refreshAccessToken(): Promise<string | null> {
  return refreshToken();
}

export async function getOrganizationDetails(): Promise<
  readonly Organization[]
> {
  return getOrganizations();
}
