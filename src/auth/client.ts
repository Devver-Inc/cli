import { Storage } from "../storage";
import { createLogtoClient } from "./logto";
import { getCurrentOrganization } from "./organization";

const API_RESOURCE = "http://localhost:9999";
const TOKEN_EXPIRY_BUFFER_SECONDS = 60;
const REDIRECT_PORT = 9999;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

interface StoredTokenEntry {
  token: string;
  scope: string;
  expiresAt: number;
}

type StoredTokens = Record<string, StoredTokenEntry>;

let server: ReturnType<typeof Bun.serve> | undefined;
let capturedAuthUrl: string | undefined;
let loginSuccessHandler: (() => void) | undefined;
let loginErrorHandler: ((e: { error: string }) => void) | undefined;

const logtoClient = createLogtoClient((url) => {
  capturedAuthUrl = url;
});

export function terminateAuthClient() {
  if (server) {
    server.stop();
    server = undefined;
  }
}

export async function startLogin() {
  capturedAuthUrl = undefined;

  await logtoClient.signIn({
    redirectUri: REDIRECT_URI,
  });

  const authUrl = capturedAuthUrl ?? "";

  server = globalThis.Bun.serve({
    port: REDIRECT_PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/callback") {
        try {
          await logtoClient.handleSignInCallback(req.url);
          if (loginSuccessHandler) {
            loginSuccessHandler();
          }
          return new Response("<h1>Success! Close this tab.</h1>", {
            headers: { "Content-Type": "text/html" },
          });
        } catch (err) {
          if (loginErrorHandler) {
            loginErrorHandler({ error: String(err) });
          }
          return new Response("<h1>Login failed</h1>", {
            status: 400,
          });
        } finally {
          if (server) {
            server.stop();
            server = undefined;
          }
        }
      }
      return new Response("Not found", { status: 404 });
    },
  });

  globalThis.Bun.spawn(["open", authUrl]);

  return {
    onSuccess: (handler: () => void) => {
      loginSuccessHandler = handler;
    },
    onError: (handler: (e: { error: string }) => void) => {
      loginErrorHandler = handler;
    },
  };
}

export async function cancelLogin() {
  await logtoClient.signOut();
  if (server) {
    server.stop();
    server = undefined;
  }
}

export async function logout() {
  await logtoClient.signOut();
}

export async function getUser() {
  if (await logtoClient.isAuthenticated()) {
    return logtoClient.getIdTokenClaims();
  }
  return null;
}

async function getStoredToken(): Promise<string | null> {
  try {
    const exists = await Storage.fileExists("logto/accessToken");
    if (!exists) {
      return null;
    }

    const content = await Storage.readToString("logto/accessToken");
    const tokens: StoredTokens = JSON.parse(content);

    const idTokenContent = await Storage.readToString("logto/idToken");
    const idToken = JSON.parse(idTokenContent);
    const organizations = (idToken?.claims?.organizations ?? []) as Array<{
      id: string;
      name: string;
    }>;

    // Get the selected organization or use the first one
    const currentOrg = await getCurrentOrganization();
    const orgId =
      currentOrg && organizations.some((org) => org.id === currentOrg)
        ? currentOrg
        : organizations[0]?.id;

    if (!orgId) {
      throw new Error(
        "You must be part of an organization to use this command. Please contact your administrator."
      );
    }

    const tokenKey = `@${API_RESOURCE}#${orgId}`;
    const entry = tokens[tokenKey];

    if (!entry) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (entry.expiresAt > now + TOKEN_EXPIRY_BUFFER_SECONDS) {
      return entry.token;
    }

    return null;
  } catch {
    return null;
  }
}

async function getAccessTokenFromLogto(orgId?: string): Promise<string | null> {
  if (await logtoClient.isAuthenticated()) {
    try {
      const claims = await logtoClient.getAccessTokenClaims(API_RESOURCE);
      const organizations = (claims?.organizations ?? []) as Array<{
        id: string;
        name: string;
        description?: string;
        roles?: Array<{ roleId: string; roleName: string }>;
      }>;

      let targetOrgId: string | undefined;
      if (orgId) {
        const orgExists = organizations.some((org) => org.id === orgId);
        if (!orgExists) {
          throw new Error(`You are not a member of organization: ${orgId}`);
        }
        targetOrgId = orgId;
      } else {
        targetOrgId = organizations[0]?.id;
      }

      if (!targetOrgId) {
        throw new Error(
          "You must be part of an organization to use this command. Please contact your administrator."
        );
      }

      return logtoClient.getAccessToken(API_RESOURCE, targetOrgId);
    } catch {
      // Fallback: try to get token with orgId from ID token if access token claims fail
      const idClaims = await logtoClient.getIdTokenClaims();
      const orgIds = idClaims?.organizations ?? [];
      const targetOrgId = orgId ?? orgIds[0];

      if (!targetOrgId) {
        throw new Error(
          "You must be part of an organization to use this command. Please contact your administrator."
        );
      }

      return logtoClient.getAccessToken(API_RESOURCE, targetOrgId);
    }
  }
  return null;
}

async function refreshToken(): Promise<string | null> {
  // Get the selected organization
  const currentOrg = await getCurrentOrganization();
  const token = await getAccessTokenFromLogto(currentOrg ?? undefined);
  await terminateAuthClient();
  return token;
}

export async function getAccessToken(): Promise<string | null> {
  const storedToken = await getStoredToken();
  if (storedToken) {
    return storedToken;
  }
  return refreshToken();
}

export function refreshAccessToken(): Promise<string | null> {
  // Force refresh - bypass stored token
  return refreshToken();
}

export interface OrganizationDetails {
  id: string;
  name: string;
  description?: string;
  roles?: Array<{ roleId: string; roleName: string }>;
}

export async function getOrganizationDetails(): Promise<OrganizationDetails[]> {
  if (await logtoClient.isAuthenticated()) {
    try {
      const claims = await logtoClient.getAccessTokenClaims(API_RESOURCE);
      return (claims?.organizations ?? []) as OrganizationDetails[];
    } catch (error) {
      console.error(
        "Failed to get access token claims, falling back to ID token:",
        error
      );
      const idClaims = await logtoClient.getIdTokenClaims();
      const orgIds = idClaims?.organizations ?? [];
      return Array.isArray(orgIds) && typeof orgIds[0] === "string"
        ? orgIds.map((id: string) => ({ id, name: id }))
        : (orgIds as unknown as OrganizationDetails[]);
    }
  }
  return [];
}
