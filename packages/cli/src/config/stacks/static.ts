export function isStaticProject(
  hasIndex: boolean,
  pkg: {
    readonly scripts?: Readonly<Record<string, string>> | undefined;
  } | null,
  hasPackageFile: boolean
): boolean {
  if (!hasIndex) {
    return false;
  }
  return pkg === null
    ? !hasPackageFile
    : (pkg.scripts?.build?.trim().length ?? 0) === 0;
}
