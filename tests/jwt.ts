type JwtPart =
  | { alg: string; typ: string }
  | {
      iss: string;
      sub: string;
      aud: string;
      iat: number;
      exp: number;
      organizations: readonly string[];
    };

const encode = (value: JwtPart) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export function idToken(claims: {
  sub?: string;
  organizations: readonly string[];
}): string {
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
