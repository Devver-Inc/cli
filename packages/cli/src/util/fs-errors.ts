/**
 * Node filesystem rejections arrive as untyped thrown values, so the only
 * trustworthy check is the documented error code.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
