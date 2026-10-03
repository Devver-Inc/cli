const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export function idToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    encode({ alg: "RS256", typ: "JWT" }),
    encode({
      iss: "https://auth.devver.app/oidc",
      sub: "test-user",
      aud: "test-app",
      iat: now,
      exp: now + 3600,
      ...claims,
    }),
    "not-a-real-signature",
  ].join(".");
}
