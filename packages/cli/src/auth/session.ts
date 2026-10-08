// Both tagged errors belong to the same scoped authentication callback protocol.
// oxlint-disable eslint/max-classes-per-file
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Data, Deferred, Effect, Schema } from "effect";

import { Storage } from "../storage";
import { createLogtoClient } from "./logto";
import { CallbackPage } from "./page";

export const API_RESOURCE = "http://localhost:9999";
const REDIRECT_PORT = 9999;
const REDIRECT_ORIGIN = `http://localhost:${REDIRECT_PORT}`;
const REDIRECT_URI = `${REDIRECT_ORIGIN}/callback`;
const CALLBACK_PATH = "/callback";
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"];

class AuthError extends Data.TaggedError("AuthError")<{ message: string }> {}
class AuthCallbackError extends Data.TaggedError("AuthCallbackError")<{
  message: string;
}> {}

const SESSION_FILES = [
  "logto/accessToken",
  "logto/idToken",
  "logto/refreshToken",
  "logto/signInSession",
  "auth/currentOrganization",
];

const OrganizationSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  roles: Schema.optional(
    Schema.Array(
      Schema.Struct({ roleId: Schema.String, roleName: Schema.String })
    )
  ),
});

const OrganizationListSchema = Schema.Array(OrganizationSchema);

const decodeOrganizationList = Schema.decodeUnknownResult(
  OrganizationListSchema
);

export type Organization = typeof OrganizationSchema.Type;

function withNavigation() {
  let navigated: string | undefined;
  const client = createLogtoClient((url) => {
    navigated = url;
  });
  return { client, url: () => navigated };
}

export async function getUser() {
  const { client } = withNavigation();
  if (await client.isAuthenticated()) {
    return await client.getIdTokenClaims();
  }
  return null;
}

export async function getOrganizations(): Promise<readonly Organization[]> {
  const { client } = withNavigation();
  if (!(await client.isAuthenticated())) {
    return [];
  }
  // Missing access claims fall back to the ID token's organization IDs.
  const claims = await client
    .getAccessTokenClaims(API_RESOURCE)
    .catch(() => null);
  if (claims?.organizations !== undefined) {
    const decoded = decodeOrganizationList(claims.organizations);
    if (decoded._tag === "Success" && decoded.success.length > 0) {
      return decoded.success;
    }
  }
  const ids = (await client.getIdTokenClaims()).organizations ?? [];
  return ids.map((id) => ({ id, name: id }));
}

export async function getAccessTokenFor(
  orgId?: string
): Promise<string | null> {
  const { client } = withNavigation();
  if (!(await client.isAuthenticated())) {
    return null;
  }
  const organizations = await getOrganizations();
  if (
    orgId !== undefined &&
    orgId !== "" &&
    !organizations.some((org) => org.id === orgId)
  ) {
    throw new Error(`You are not a member of organization: ${orgId}`);
  }
  const targetOrgId = orgId ?? organizations[0]?.id;
  if (targetOrgId === undefined || targetOrgId === "") {
    throw new Error(
      "You must be part of an organization to use this command. Please contact your administrator."
    );
  }
  return await client.getAccessToken(API_RESOURCE, targetOrgId);
}

export async function logout(): Promise<string | undefined> {
  const { client, url } = withNavigation();
  await client.signOut();
  const logoutUrl = url();
  for (const file of SESSION_FILES) {
    if (await Storage.fileExists(file)) {
      await Storage.deleteFile(file);
    }
  }
  return logoutUrl;
}

export const serveCallback = (handle: (requestUrl: string) => Promise<void>) =>
  Effect.gen(function* () {
    const completed = yield* Deferred.make<undefined, AuthCallbackError>();

    const handler = (
      request: IncomingMessage,
      response: ServerResponse
    ): void => {
      const path = new URL(request.url ?? "/", REDIRECT_ORIGIN).pathname;
      if (path !== CALLBACK_PATH) {
        response.writeHead(404, { Connection: "close" }).end("Not found");
        return;
      }
      void (async () => {
        try {
          await handle(`${REDIRECT_ORIGIN}${request.url ?? ""}`);
          response
            .writeHead(200, {
              "Content-Type": "text/html",
              Connection: "close",
            })
            .end(CallbackPage.success);
          // Deferred completion requires an explicit undefined value.
          // oxlint-disable-next-line unicorn/no-useless-undefined
          Effect.runFork(Deferred.succeed(completed, undefined));
        } catch (error) {
          response
            .writeHead(400, {
              "Content-Type": "text/html",
              Connection: "close",
            })
            .end(CallbackPage.failure);
          Effect.runFork(
            Deferred.fail(
              completed,
              new AuthCallbackError({
                message:
                  error instanceof Error
                    ? error.message
                    : "Sign-in callback failed",
              })
            )
          );
        }
      })();
    };

    const servers = LOOPBACK_HOSTS.map(() => createServer(handler));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const server of servers) {
          server.closeAllConnections?.();
          server.close();
        }
      })
    );

    const bound = yield* Effect.forEach(
      LOOPBACK_HOSTS,
      (host, index) =>
        Effect.callback<boolean>((resume) => {
          const server = servers[index];
          if (server === undefined) {
            resume(Effect.succeed(false));
            return;
          }
          server.once("error", () => {
            resume(Effect.succeed(false));
          });
          server.listen(REDIRECT_PORT, host, () => {
            resume(Effect.succeed(true));
          });
        }),
      { concurrency: 1 }
    );
    if (!bound.includes(true)) {
      return yield* Effect.fail(
        new AuthError({
          message: `Could not listen on port ${REDIRECT_PORT} for the sign-in callback. Close whatever is using it and try again.`,
        })
      );
    }

    // Return the completion Effect to the caller; login must open the browser first.
    // @effect-diagnostics-next-line returnEffectInGen:off
    return Deferred.await(completed);
  });

export const login = Effect.gen(function* () {
  const { client, url } = withNavigation();
  const completed = yield* serveCallback(async (requestUrl) =>
    client.handleSignInCallback(requestUrl)
  );

  yield* Effect.tryPromise({
    try: async () =>
      client.signIn({
        redirectUri: REDIRECT_URI,
        extraParams: { max_age: "0" },
      }),
    catch: () => new AuthError({ message: "Sign-in failed. Try again." }),
  });

  const authUrl = url();
  if (authUrl === undefined || authUrl === "") {
    return yield* Effect.fail(
      new AuthError({ message: "Logto did not provide a sign-in URL." })
    );
  }
  return { authUrl, completed };
});
