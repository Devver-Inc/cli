export const isAlreadyExists = (
  error: unknown
): error is Error & { code: "EEXIST" } =>
  error instanceof Error && "code" in error && error.code === "EEXIST";
