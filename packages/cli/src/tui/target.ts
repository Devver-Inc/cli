import type { Candidate } from "../core/update";
import type {
  LocalDeployment,
  LocalDeploymentStatus,
} from "../infra/api/local-deploy.requests";
import type { Organization } from "../infra/auth/session";

export interface LocalTarget {
  readonly kind: "local";
  readonly server: string;
  readonly workspace: string;
  readonly repositoryId?: string | undefined;
  readonly openInBrowser?: ((url: string) => Promise<boolean>) | undefined;
  readonly copyUrl?: ((url: string) => Promise<boolean>) | undefined;
  readonly loadDeployments: () => Promise<
    readonly LocalDeploymentStatus[] | null
  >;
  readonly renameDeployment?:
    | ((id: string, name: string) => Promise<{ readonly displayName: string }>)
    | undefined;
  readonly mergeDeployments?:
    | ((first: string, second: string) => Promise<LocalDeployment>)
    | undefined;
}

export interface CloudTarget {
  readonly kind: "cloud";
  readonly project?: string | undefined;
  readonly currentProjectId?: string | null | undefined;
  readonly loadProjects?:
    | (() => Promise<readonly { id: string; name: string }[]>)
    | undefined;
  readonly onSwitchProject?: ((id: string) => Promise<void>) | undefined;
  readonly organizations?: readonly Organization[] | undefined;
  readonly currentOrganization?: string | null | undefined;
  readonly onSwitchOrganization?:
    | ((current: string | null, id: string) => Promise<void>)
    | undefined;
}

export interface AppProps {
  readonly target: CloudTarget | LocalTarget | { readonly kind: "none" };
  readonly version?: string | undefined;
  readonly update?: Candidate | undefined;
  readonly checkUpdate?: (() => Promise<Candidate | undefined>) | undefined;
  readonly onExit: () => void;
}
