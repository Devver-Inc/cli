import { openTunnelRouter } from "./publications";

export interface PublicRouter {
  readonly publicUrl: (deploymentId: string) => string | undefined;
  readonly publish: (deploymentId: string) => Promise<string>;
  readonly unpublish: (deploymentId: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

export const openPublicRouter = (
  ...args: Parameters<typeof openTunnelRouter>
): PublicRouter => openTunnelRouter(...args);
