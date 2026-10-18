// This single export is the server's narrow public entry point.
export { serve } from "./src/index";
export { openDeploymentHost, stopDeploymentHost } from "./src/deployment-host";
export { portPlaceholder } from "./src/deployment-host";
export type { DaemonSpec, DeploymentHost } from "./src/deployment-host";
