import { Schema } from "effect";
import { Storage } from "../storage";
import { getCurrentOrganization } from "./organization";
import {
  API_RESOURCE,
  getAccessTokenFor,
  getOrganizations,
  type Organization,
} from "./session";

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

function decodeCredential<A>(
  decode: (input: unknown) => A,
  parsed: unknown,
  label: string
): A {
  try {
    return decode(parsed);
  } catch {
    throw new Error(
      `Stored ${label} has an unexpected shape. Please log in again.`
    );
  }
}

function parseJson(content: string, label: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`Stored ${label} is not valid JSON. Please log in again.`);
  }
}

function decodeJwtClaims(token: string, label: string): unknown {
  const payload = token.split(".")[1];
  if (!payload) {
    throw new Error(`Stored ${label} is not a JWT. Please log in again.`);
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error(
      `Stored ${label} has an unreadable payload. Please log in again.`
    );
  }
}

async function getStoredOrganizationIds(): Promise<readonly string[]> {
  if (!(await Storage.fileExists("logto/idToken"))) {
    return [];
  }
  const content = (await Storage.readToString("logto/idToken")).trim();
  const claims = decodeCredential(
    decodeIdTokenClaims,
    decodeJwtClaims(content, "ID token"),
    "ID token"
  );
  return claims.organizations ?? [];
}

async function getStoredToken(): Promise<string | null> {
  if (!(await Storage.fileExists("logto/accessToken"))) {
    return null;
  }
  const content = await Storage.readToString("logto/accessToken");
  const tokens = decodeCredential(
    decodeStoredTokens,
    parseJson(content, "access token"),
    "access token"
  );
  const organizationIds = await getStoredOrganizationIds();

  const currentOrg = await getCurrentOrganization();
  if (currentOrg && !organizationIds.includes(currentOrg)) {
    throw new Error(`Selected organization '${currentOrg}' is unavailable`);
  }
  const orgId = currentOrg ?? organizationIds[0];
  if (!orgId) {
    return null;
  }

  const entry = tokens[`@${API_RESOURCE}#${orgId}`];
  if (!entry) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  return entry.expiresAt > now + TOKEN_EXPIRY_BUFFER_SECONDS
    ? entry.token
    : null;
}

async function refreshToken(): Promise<string | null> {
  const currentOrg = await getCurrentOrganization();
  if (currentOrg) {
    const organizations = await getOrganizations();
    if (!organizations.some((org) => org.id === currentOrg)) {
      throw new Error(`Selected organization '${currentOrg}' is unavailable`);
    }
  }
  return await getAccessTokenFor(currentOrg ?? undefined);
}

export async function getAccessToken(): Promise<string | null> {
  const storedToken = await getStoredToken();
  if (storedToken) {
    return storedToken;
  }
  return await refreshToken();
}

export function refreshAccessToken(): Promise<string | null> {
  return refreshToken();
}

export function getOrganizationDetails(): Promise<readonly Organization[]> {
  return getOrganizations();
}
