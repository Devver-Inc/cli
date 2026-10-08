/**
 * Node filesystem rejections arrive as untyped thrown values, so the only
 * trustworthy check is the documented error code.
 */
export const isAlreadyExists = (
  error: unknown
): error is Error & { code: "EEXIST" } =>
  error instanceof Error && "code" in error && error.code === "EEXIST";
