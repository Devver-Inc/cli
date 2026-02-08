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
  async logout() {
    await client.signOut();
  },
  async cancelLogin() {
    await client.signOut();
  },
  async getAccessToken() {
    if (await client.isAuthenticated()) {
      const claims = await client.getIdTokenClaims();
      const orgId = claims?.organizations?.[0];
      if (orgId) {
        return client.getAccessToken("http://localhost:9999", orgId);
      }
      return client.getAccessToken("http://localhost:9999");
    }
    return null;
  },
};
Rpc.listen(rpc);
