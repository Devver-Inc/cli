// biome-ignore lint/performance/noBarrelFile: These named exports form the owner-only state entry point.
export {
  verifyWindowsPrivate,
  windowsPrivateDirectories,
  windowsServersDirectory,
} from "./src/windows-acl";
