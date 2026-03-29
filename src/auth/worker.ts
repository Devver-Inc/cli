import { Rpc } from "../util/rpc";
import { createLogtoClient } from "./logto";

const REDIRECT_PORT = 9999;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

let server: ReturnType<typeof Bun.serve> | undefined;
let capturedAuthUrl: string | undefined;

const client = createLogtoClient((url) => {
  capturedAuthUrl = url;
});

export const rpc = {
  async startLogin() {
    capturedAuthUrl = undefined;

    await client.signIn({
      redirectUri: REDIRECT_URI,
    });

    const authUrl = capturedAuthUrl ?? "";

    server = globalThis.Bun.serve({
      port: REDIRECT_PORT,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/callback") {
          try {
            await client.handleSignInCallback(req.url);
            Rpc.emit("login.success", { success: true });
            return new Response("<h1>Success! Close this tab.</h1>", {
              headers: { "Content-Type": "text/html" },
            });
          } catch (err) {
            Rpc.emit("login.error", { error: String(err) });
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
    return { url: authUrl };
  },
  stopServer() {
    if (server) {
      server.stop();
      server = undefined;
    }
  },
  async getUser() {
    if (await client.isAuthenticated()) {
      return client.getIdTokenClaims();
    }
    return null;
  },
  async getOrganizations() {
    if (await client.isAuthenticated()) {
      try {
        const claims = await client.getAccessTokenClaims(
          "http://localhost:9999"
        );
        return claims?.organizations ?? [];
      } catch (error) {
        console.error(
          "Failed to get access token claims, falling back to ID token:",
          error
        );
        const idClaims = await client.getIdTokenClaims();
        const orgIds = idClaims?.organizations ?? [];
        return Array.isArray(orgIds) && typeof orgIds[0] === "string"
          ? orgIds.map((id: string) => ({ id, name: id }))
          : orgIds;
      }
    }
    return [];
  },
  async logout() {
    await client.signOut();
  },
  async cancelLogin() {
    await client.signOut();
  },
  async getAccessToken(input: unknown) {
    const { orgId } = (input as { orgId?: string }) ?? {};

    if (await client.isAuthenticated()) {
      try {
        const claims = await client.getAccessTokenClaims(
          "http://localhost:9999"
        );
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

        return client.getAccessToken("http://localhost:9999", targetOrgId);
      } catch {
        // Fallback: try to get token with orgId from ID token if access token claims fail
        const idClaims = await client.getIdTokenClaims();
        const orgIds = idClaims?.organizations ?? [];
        const targetOrgId = orgId ?? orgIds[0];

        if (!targetOrgId) {
          throw new Error(
            "You must be part of an organization to use this command. Please contact your administrator."
          );
        }

        return client.getAccessToken("http://localhost:9999", targetOrgId);
      }
    }
    return null;
  },
};
Rpc.listen(rpc);
