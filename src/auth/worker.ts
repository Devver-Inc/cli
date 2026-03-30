/**
 * Auth worker -- runs in a separate Bun Worker thread.
 *
 * Hosts a temporary HTTP server on REDIRECT_PORT to receive the Logto
 * OAuth callback, so the main CLI thread stays responsive.
 * Communicates with the main thread via Rpc.listen / Rpc.emit.
 */

import { Storage } from "../storage";
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
      extraParams: {
        max_age: "0", // Force re-authentication by requiring immediate re-login
      },
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
            return new Response(
              `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authentication Successful</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: #c7c5d8;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      color: #1a202c;
    }
    .container {
      background: white;
      border-radius: 24px;
      padding: 64px 80px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
      text-align: center;
      max-width: 540px;
      animation: slideIn 0.4s ease-out;
    }
    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(-20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    .icon {
      width: 96px;
      height: 96px;
      background: #7958dc;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 32px;
      animation: checkmark 0.6s ease-in-out;
    }
    @keyframes checkmark {
      0% {
        transform: scale(0);
        opacity: 0;
      }
      50% {
        transform: scale(1.1);
      }
      100% {
        transform: scale(1);
        opacity: 1;
      }
    }
    .checkmark {
      width: 40px;
      height: 40px;
      border: 4px solid white;
      border-top: none;
      border-right: none;
      transform: rotate(-45deg);
      margin-top: -8px;
    }
    h1 {
      font-size: 36px;
      font-weight: 700;
      margin-bottom: 16px;
      color: #191c1d;
      letter-spacing: -0.02em;
    }
    p {
      font-size: 17px;
      color: #747778;
      line-height: 1.6;
      margin-bottom: 8px;
    }
    .close-instruction {
      font-size: 15px;
      color: #9e9fa1;
      margin-top: 24px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">
      <div class="checkmark"></div>
    </div>
    <h1>Authentication Successful!</h1>
    <p>You have successfully logged in to Devver.</p>
    <p class="close-instruction">You can now close this tab and return to your terminal.</p>
  </div>
  <script>
    setTimeout(() => {
      window.close();
    }, 2000);
  </script>
</body>
</html>`,
              {
                headers: { "Content-Type": "text/html" },
              }
            );
          } catch (err) {
            Rpc.emit("login.error", { error: String(err) });
            return new Response(
              `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authentication Failed</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      color: #1a202c;
    }
    .container {
      background: white;
      border-radius: 16px;
      padding: 48px 64px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      text-align: center;
      max-width: 500px;
    }
    .icon {
      width: 80px;
      height: 80px;
      background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      font-size: 40px;
      color: white;
    }
    h1 {
      font-size: 32px;
      font-weight: 700;
      margin-bottom: 12px;
      color: #1a202c;
    }
    p {
      font-size: 16px;
      color: #718096;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">✕</div>
    <h1>Authentication Failed</h1>
    <p>There was a problem logging you in. Please try again.</p>
  </div>
</body>
</html>`,
              {
                status: 400,
                headers: { "Content-Type": "text/html" },
              }
            );
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
    capturedAuthUrl = undefined;

    await client.signOut();

    const logoutUrl = capturedAuthUrl;

    const filesToClear = [
      "logto/accessToken",
      "logto/idToken",
      "logto/refreshToken",
      "logto/signInSession",
      "auth/currentOrganization",
    ];

    for (const file of filesToClear) {
      try {
        const exists = await Storage.fileExists(file);
        if (exists) {
          await Storage.deleteFile(file);
        }
      } catch (error) {
        console.error(`Failed to clear ${file}:`, error);
      }
    }

    return { url: logoutUrl };
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
