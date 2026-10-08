/**
 * Every endpoint this server answers, declared in one place.
 *
 * A handler receives the instance state loaded at startup and returns the body
 * to send. Transport concerns stay in `index.ts`: it owns the loopback
 * listener, the same-origin checks and the `/api/v1` prefix, so a new endpoint
 * is one entry here plus its response type, and needs no change to any of that.
 */

import pkg from "../../../package.json" with { type: "json" };
import type { loadInstance } from "./identity";

/** What the server knows before any request arrives. */
interface RouteContext {
  readonly instance: Awaited<ReturnType<typeof loadInstance>>;
}

/**
 * The attach handshake the CLI decodes before it trusts an instance. The
 * protocol version is bumped when a response stops being readable by an
 * older CLI.
 */
export type IdentityResponse = RouteContext["instance"] & {
  readonly serverVersion: string;
  readonly controlProtocolVersion: 1;
};

/** Every body this server can send; one member per endpoint. */
type RouteResponse = IdentityResponse;

interface Route {
  readonly method: "GET";
  /** Path below the API prefix, matched exactly. */
  readonly path: string;
  readonly handler: (context: RouteContext) => RouteResponse;
}

export const routes: readonly Route[] = [
  {
    method: "GET",
    path: "/identity",
    handler: ({ instance }) => ({
      ...instance,
      serverVersion: pkg.version,
      controlProtocolVersion: 1,
    }),
  },
];

/** The route for a path, plus the methods it accepts, for a 404/405 decision. */
export function matchRoute(path: string, method: string | undefined) {
  const candidates = routes.filter((route) => route.path === path);
  if (candidates.length === 0) {
    return { outcome: "unknown-path" } as const;
  }
  const route = candidates.find((candidate) => candidate.method === method);
  if (route === undefined) {
    return {
      outcome: "wrong-method",
      allow: candidates.map((candidate) => candidate.method).join(", "),
    } as const;
  }
  return { outcome: "matched", route } as const;
}
