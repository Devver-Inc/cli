import { RGBA, TextAttributes } from "@opentui/core";
import type { ColorInput, KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";

import type { LocalDeploymentStatus } from "../api/local-deploy.requests";
import { openBrowser } from "../auth/browser";
import type { Organization } from "../auth/session";
import { visibleDeployments } from "./deployments";
import { actionFor } from "./keys";
import type { shortcuts } from "./keys";
import { theme } from "./theme";

const terminalBackground = RGBA.defaultBackground();
const scrollbarOptions = {
  trackOptions: {
    backgroundColor: terminalBackground,
    foregroundColor: theme.muted,
  },
};

interface LocalTarget {
  readonly kind: "local";
  readonly server: string;
  readonly workspace: string;
  readonly repositoryId?: string | undefined;
  readonly openInBrowser?: ((url: string) => Promise<boolean>) | undefined;
  readonly copyUrl?: ((url: string) => Promise<boolean>) | undefined;
  readonly loadDeployments: () => Promise<
    readonly LocalDeploymentStatus[] | null
  >;
}

interface CloudTarget {
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
  readonly onExit: () => void;
}

function useOrganizationSelection({
  organizations = [],
  currentOrganization = null,
  onSwitchOrganization,
}: Pick<
  CloudTarget,
  "organizations" | "currentOrganization" | "onSwitchOrganization"
>) {
  const [orgId, setOrgId] = useState(currentOrganization);
  const [confirmedId, setConfirmedId] = useState(
    currentOrganization ?? organizations[0]?.id
  );
  const [orgPicker, setOrgPicker] = useState(false);
  const [orgIndex, setOrgIndex] = useState(0);
  const [orgError, setOrgError] = useState("");
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);
  const orgList = useRef<ScrollBoxRenderable>(null);
  const currentOrg =
    organizations.find((org) => org.id === orgId) ??
    (orgId !== null && orgId !== "" ? undefined : organizations[0]);

  useEffect(() => {
    if (orgError === "") {
      return undefined;
    }
    const timer = setTimeout(() => {
      setOrgError("");
    }, 4000);
    return () => {
      clearTimeout(timer);
    };
  }, [orgError]);

  useEffect(() => {
    if (!orgPicker) {
      return undefined;
    }
    const choice = organizations[orgIndex];
    const timer = setTimeout(() => {
      if (choice !== undefined) {
        orgList.current?.scrollChildIntoView(`organization-${choice.id}`);
      }
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [orgPicker, orgIndex, organizations]);

  function open() {
    setOrgIndex(
      Math.max(
        0,
        organizations.findIndex((org) => org.id === currentOrg?.id)
      )
    );
    setOrgError("");
    setOrgPicker(true);
  }

  function handle(
    action: keyof typeof shortcuts | undefined,
    key: KeyEvent,
    onExit: () => void
  ) {
    if (switchingRef.current) {
      return;
    }
    if (action === "cancel") {
      setOrgPicker(false);
    } else if (action === "up") {
      setOrgIndex((index) => Math.max(0, index - 1));
    } else if (action === "down") {
      setOrgIndex((index) => Math.min(organizations.length - 1, index + 1));
    } else if (action === "confirm") {
      const choice = organizations[orgIndex];
      if (choice === undefined || onSwitchOrganization === undefined) {
        return;
      }
      if (choice.id === currentOrg?.id) {
        setOrgPicker(false);
        return;
      }
      switchingRef.current = true;
      setSwitching(true);
      setOrgError("");
      setOrgId(choice.id);
      setOrgPicker(false);
      onSwitchOrganization(orgId, choice.id)
        .then(() => {
          setConfirmedId(choice.id);
        })
        .catch(() => {
          setOrgId(orgId);
          setOrgError("Could not switch organization. Check your selection.");
        })
        .finally(() => {
          switchingRef.current = false;
          setSwitching(false);
        });
    } else if (action === "quit" && key.ctrl) {
      onExit();
    }
  }

  return {
    orgId,
    confirmedId,
    orgPicker,
    orgIndex,
    orgError,
    switching,
    orgList,
    currentOrg,
    open,
    handle,
  };
}

function OrganizationPicker({
  organizations,
  currentOrg,
  orgIndex,
  orgList,
  switching,
  orgError,
}: {
  readonly organizations: readonly Organization[];
  readonly currentOrg?: Organization | undefined;
  readonly orgIndex: number;
  readonly orgList: React.RefObject<ScrollBoxRenderable | null>;
  readonly switching: boolean;
  readonly orgError: string;
}): React.ReactNode {
  return (
    <box
      border
      borderColor={theme.line}
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      paddingX={1}
      title=" organizations "
      titleColor={theme.mint}
    >
      <text fg={theme.muted} height={1} wrapMode="none">
        Select organization · ↑/↓ · Enter · Esc
      </text>
      <scrollbox
        flexGrow={1}
        minHeight={0}
        ref={orgList}
        scrollbarOptions={scrollbarOptions}
      >
        {organizations.length === 0 && (
          <text fg={theme.amber}>
            No organizations available. Run devver auth login.
          </text>
        )}
        {organizations.map((org, index): React.ReactNode => (
          <text
            attributes={
              index === orgIndex ? TextAttributes.BOLD : TextAttributes.NONE
            }
            fg={index === orgIndex ? theme.mint : theme.ink}
            id={`organization-${org.id}`}
            key={org.id}
          >
            {index === orgIndex ? "◆" : " "} {org.name}
            {org.id === currentOrg?.id ? " (current)" : ""}
          </text>
        ))}
      </scrollbox>
      {switching && <text fg={theme.muted}>Switching organization…</text>}
      {orgError !== "" && <text fg={theme.rose}>{orgError}</text>}
    </box>
  );
}

function useProjectSelection({
  currentProjectId = null,
  loadProjects,
  onSwitchProject,
  organizationId,
  initialOrganizationId,
}: Pick<
  CloudTarget,
  "currentProjectId" | "loadProjects" | "onSwitchProject"
> & {
  organizationId?: string | undefined;
  initialOrganizationId: string | null;
}) {
  const [projects, setProjects] = useState<
    readonly { id: string; name: string }[]
  >([]);
  const [projectId, setProjectId] = useState(currentProjectId);
  const [picker, setPicker] = useState(false);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const list = useRef<ScrollBoxRenderable>(null);
  const currentOrganizationRef = useRef(organizationId);
  currentOrganizationRef.current = organizationId;

  useEffect(() => {
    if (
      loadProjects === undefined ||
      organizationId === undefined ||
      organizationId === ""
    ) {
      setProjects([]);
      return undefined;
    }
    let active = true;
    setError("");
    setLoading(true);
    setProjects([]);
    if (organizationId !== initialOrganizationId) {
      setProjectId(null);
    }
    loadProjects()
      .then((result) => {
        if (active) {
          setProjects(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setError("Could not load projects. Reopen the selector to retry.");
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [organizationId, loadProjects, initialOrganizationId]);

  useEffect(() => {
    if (!picker) {
      return undefined;
    }
    const choice = projects[index];
    const timer = setTimeout(() => {
      if (choice !== undefined) {
        list.current?.scrollChildIntoView(`project-${choice.id}`);
      }
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [picker, index, projects]);

  function open() {
    setIndex(
      Math.max(
        0,
        projects.findIndex((entry) => entry.id === projectId)
      )
    );
    setPicker(true);
    if (
      loadProjects !== undefined &&
      organizationId !== undefined &&
      organizationId !== ""
    ) {
      setError("");
      setLoading(true);
      const requestedOrganization = organizationId;
      loadProjects()
        .then((result) => {
          if (currentOrganizationRef.current === requestedOrganization) {
            setProjects(result);
            setLoading(false);
          }
        })
        .catch(() => {
          if (currentOrganizationRef.current === requestedOrganization) {
            setError("Could not load projects. Try again.");
            setLoading(false);
          }
        });
    } else {
      setError("Select an organization first.");
    }
  }

  function handle(
    action: keyof typeof shortcuts | undefined,
    key: KeyEvent,
    onExit: () => void
  ) {
    if (busyRef.current) {
      return;
    }
    if (action === "cancel") {
      setPicker(false);
    } else if (action === "up") {
      setIndex((value) => Math.max(0, value - 1));
    } else if (action === "down") {
      setIndex((value) => Math.min(projects.length - 1, value + 1));
    } else if (action === "confirm") {
      const choice = projects[index];
      if (choice === undefined || onSwitchProject === undefined) {
        return;
      }
      if (choice.id === projectId) {
        setPicker(false);
        return;
      }
      busyRef.current = true;
      setBusy(true);
      onSwitchProject(choice.id)
        .then(() => {
          setProjectId(choice.id);
          setPicker(false);
        })
        .catch(() => {
          setError("Could not switch project. Try again.");
        })
        .finally(() => {
          busyRef.current = false;
          setBusy(false);
        });
    } else if (action === "quit" && key.ctrl) {
      onExit();
    }
  }
  return {
    projects,
    projectId,
    loading,
    picker,
    index,
    error,
    busy,
    list,
    open,
    handle,
  };
}

function ProjectPicker({
  projects,
  projectId,
  index,
  error,
  busy,
  loading,
  list,
}: ReturnType<typeof useProjectSelection>): React.ReactNode {
  return (
    <box
      border
      borderColor={theme.line}
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      paddingX={1}
      title=" projects "
      titleColor={theme.mint}
    >
      <text fg={theme.muted} height={1} wrapMode="none">
        Select project · ↑/↓ · Enter · Esc
      </text>
      <scrollbox
        flexGrow={1}
        minHeight={0}
        ref={list}
        scrollbarOptions={scrollbarOptions}
      >
        {loading && <text fg={theme.muted}>Loading projects…</text>}
        {!loading && projects.length === 0 && error === "" && (
          <text fg={theme.muted}>
            No projects available in this organization.
          </text>
        )}
        {projects.map((entry, position): React.ReactNode => (
          <text
            fg={position === index ? theme.mint : theme.ink}
            id={`project-${entry.id}`}
            key={entry.id}
          >
            {position === index ? "◆" : " "} {entry.name}
            {entry.id === projectId ? " (current)" : ""}
          </text>
        ))}
      </scrollbox>
      {busy && <text fg={theme.muted}>Switching project…</text>}
      {error !== "" && <text fg={theme.rose}>{error}</text>}
    </box>
  );
}

function headerLabels(
  org: ReturnType<typeof useOrganizationSelection>,
  projects: ReturnType<typeof useProjectSelection>,
  project: string | undefined,
  hasProjectLoader: boolean
): string {
  const organization =
    org.currentOrg?.name ??
    (org.orgId !== null && org.orgId !== ""
      ? `Unknown (${org.orgId})`
      : "No organization");
  const selectedProject = projects.projects.find(
    (entry) => entry.id === projects.projectId
  )?.name;
  const projectName = org.switching
    ? "Switching organization…"
    : (selectedProject ??
      (hasProjectLoader ? "Select project" : (project ?? "No project")));
  return `${organization} / ${projectName}`;
}

function shortcutHelp(pickerOpen: boolean): string {
  return pickerOpen
    ? "j/k ↑/↓ move · Enter select · Esc cancel"
    : "g organization · p project · q quit";
}

function CloudApp({
  target: {
    project,
    currentProjectId = null,
    loadProjects,
    onSwitchProject,
    organizations = [],
    currentOrganization = null,
    onSwitchOrganization,
  },
  version,
  onExit,
}: AppProps & { readonly target: CloudTarget }): React.ReactNode {
  const org = useOrganizationSelection({
    organizations,
    currentOrganization,
    onSwitchOrganization,
  });
  const projects = useProjectSelection({
    currentProjectId,
    loadProjects,
    onSwitchProject,
    organizationId: org.confirmedId,
    initialOrganizationId: currentOrganization,
  });
  let pickerView: React.ReactNode;
  if (org.orgPicker) {
    pickerView = <OrganizationPicker {...org} organizations={organizations} />;
  } else if (projects.picker) {
    pickerView = <ProjectPicker {...projects} />;
  }

  useKeyboard((key) => {
    const action = actionFor(key);
    if (projects.picker) {
      projects.handle(action, key, onExit);
      return;
    }
    if (org.orgPicker) {
      org.handle(action, key, onExit);
      return;
    }
    if (org.switching) {
      return;
    }
    if (action === "organization") {
      org.open();
    } else if (action === "project") {
      projects.open();
    } else if (action === "quit") {
      onExit();
    }
  });

  return (
    <box
      backgroundColor={terminalBackground}
      flexDirection="column"
      height="100%"
      width="100%"
    >
      <box
        borderColor={theme.line}
        borderStyle="single"
        flexDirection="row"
        height={3}
        justifyContent="space-between"
        paddingX={1}
      >
        <text attributes={TextAttributes.BOLD} fg={theme.mint}>
          dv{" "}
          <span fg={theme.ink}>
            {headerLabels(org, projects, project, Boolean(loadProjects))}
          </span>
        </text>
      </box>
      {pickerView ?? (
        <box
          border
          borderColor={theme.line}
          flexDirection="column"
          flexGrow={1}
          minHeight={0}
          paddingX={1}
          title=" deployments "
          titleColor={theme.mint}
        >
          <text fg={theme.muted}>
            Deployment browsing is not available yet. No deployment data has
            been loaded.
          </text>
        </box>
      )}
      <box
        borderColor={theme.line}
        borderStyle="single"
        flexDirection="row"
        height={3}
        justifyContent="space-between"
        paddingX={1}
      >
        <text
          fg={org.orgError === "" ? theme.muted : theme.rose}
          flexGrow={1}
          minWidth={0}
          wrapMode="none"
        >
          {org.orgError === ""
            ? shortcutHelp(org.orgPicker || projects.picker)
            : org.orgError}
        </text>
        <text fg={theme.muted} wrapMode="none">
          {version !== undefined && version !== "" ? `v${version}` : ""}
        </text>
      </box>
    </box>
  );
}

interface FlatDeployment {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly repositoryId: string | undefined;
  readonly commit: string | undefined;
  readonly status: LocalDeploymentStatus["status"];
  readonly stage: LocalDeploymentStatus["stage"];
  // undefined: the server did not report a URL field; null: reported as none.
  readonly url: string | null | undefined;
}

interface TreeNode extends FlatDeployment {
  readonly children: readonly TreeNode[];
}

// One row per node, depth-first in source order, each indented past its parent.
function flatten(
  nodes: readonly TreeNode[],
  depth = 0
): (FlatDeployment & { readonly depth: number })[] {
  const flattened: (FlatDeployment & { readonly depth: number })[] = [];
  for (const node of nodes) {
    flattened.push({ ...node, depth });
    for (const row of flatten(node.children, depth + 1)) {
      flattened.push(row);
    }
  }
  return flattened;
}

// A deployment hangs under its parentDeploymentId when the list contains it;
// anything else (null parent, unknown parent, cross-repository) is a root.
function buildTree(rows: readonly FlatDeployment[]): TreeNode[] {
  const byId = new Map<string, FlatDeployment & { children: TreeNode[] }>();
  for (const row of rows) {
    byId.set(row.id, { ...row, children: [] });
  }
  const roots: (FlatDeployment & { children: TreeNode[] })[] = [];
  for (const row of rows) {
    const parent =
      row.parentId === undefined ? undefined : byId.get(row.parentId);
    const node = byId.get(row.id);
    if (node === undefined) {
      continue;
    }
    if (parent === undefined || parent === node) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }
  return roots;
}

function treeRow(
  entry: FlatDeployment & { readonly depth: number },
  selected: boolean
): React.ReactNode {
  const indent = "  ".repeat(entry.depth);
  const branch = entry.depth === 0 ? "" : `${"│ ".repeat(entry.depth - 1)}└─ `;
  const marker = selected ? "◆" : " ";
  let color: ColorInput = theme.amber;
  if (selected) {
    color = theme.mint;
  } else if (entry.status === "ready") {
    color = theme.ink;
  }
  return (
    <text
      attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE}
      fg={color}
      key={entry.id}
      wrapMode="none"
    >
      {`${marker} ${indent}${branch}${entry.id.slice(0, 8)} ${entry.status}`}
      {entry.stage === null || entry.stage === undefined
        ? ""
        : ` (${entry.stage})`}
      {entry.commit === undefined ? "" : `  ${entry.commit.slice(0, 8)}`}
    </text>
  );
}

function LocalApp({
  target,
  version,
  onExit,
}: AppProps & { readonly target: LocalTarget }): React.ReactNode {
  const [result, setResult] = useState<
    | { readonly kind: "loading" | "failed" | "unsupported" }
    | {
        readonly kind: "loaded";
        readonly deployments: readonly LocalDeploymentStatus[];
      }
  >({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState("");
  const list = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    let active = true;
    target
      .loadDeployments()
      .then((deployments) => {
        if (active) {
          setResult(
            deployments === null
              ? { kind: "unsupported" }
              : { kind: "loaded", deployments }
          );
        }
      })
      .catch(() => {
        if (active) {
          setResult({ kind: "failed" });
        }
      });
    return () => {
      active = false;
    };
  }, [target.loadDeployments]);

  const rows =
    result.kind === "loaded"
      ? flatten(
          buildTree(
            visibleDeployments(result.deployments, target.repositoryId).map(
              (entry) => ({
                id: entry.deploymentId,
                parentId: entry.parentDeploymentId ?? undefined,
                repositoryId: entry.repositoryId,
                commit: entry.commit,
                status: entry.status,
                stage: entry.stage,
                url: entry.url,
              })
            )
          )
        )
      : [];

  useEffect(() => {
    if (selectedId === undefined && rows.length > 0) {
      setSelectedId(rows[0]?.id);
    }
  }, [rows, selectedId]);

  useEffect(() => {
    if (status === "") {
      return undefined;
    }
    const timer = setTimeout(() => {
      setStatus("");
    }, 4000);
    return () => {
      clearTimeout(timer);
    };
  }, [status]);

  function copySelected(current: FlatDeployment | undefined) {
    const url = current?.url;
    if (
      current?.status !== "ready" ||
      url === undefined ||
      url === null ||
      url === ""
    ) {
      setStatus("This deployment has no ready URL to copy.");
      return;
    }
    if (target.copyUrl === undefined) {
      setStatus("Could not copy the deployment URL.");
      return;
    }
    void target.copyUrl(url).then(
      (copied) => {
        setStatus(
          copied
            ? "Sent deployment URL to clipboard."
            : "Could not copy the deployment URL."
        );
      },
      () => {
        setStatus("Could not copy the deployment URL.");
      }
    );
  }

  function navigate(action: keyof typeof shortcuts | undefined) {
    const index = rows.findIndex((row) => row.id === selectedId);
    const current = rows[index === -1 ? 0 : index];
    if (action === "down") {
      const next = rows[(index + 1) % rows.length];
      if (next !== undefined) {
        setSelectedId(next.id);
      }
    } else if (action === "up") {
      const previous = rows[(index - 1 + rows.length) % rows.length];
      if (previous !== undefined) {
        setSelectedId(previous.id);
      }
    } else if (action === "right") {
      const child = rows.find((row) => row.parentId === current?.id);
      const next = child ?? rows[(index + 1) % rows.length];
      if (next !== undefined) {
        setSelectedId(next.id);
      }
    } else if (action === "left") {
      if (current?.parentId === undefined) {
        const previous = rows[(index - 1 + rows.length) % rows.length];
        if (previous !== undefined) {
          setSelectedId(previous.id);
        }
      } else {
        setSelectedId(current.parentId);
      }
    } else if (action === "copy") {
      copySelected(current);
    } else if (action === "open") {
      const url = current?.url;
      if (url === undefined) {
        setStatus(
          "This server does not report deployment URLs. Re-create it from a current build."
        );
        return;
      }
      if (url === null) {
        setStatus("This deployment is not ready, so it has no URL to open.");
        return;
      }
      const opener = target.openInBrowser ?? openBrowser;
      void opener(url).then((opened) => {
        setStatus(
          opened
            ? `Opened ${url}`
            : "Could not open a browser for this deployment."
        );
      });
    }
  }

  useKeyboard((key) => {
    const action = actionFor(key);
    if (action === "quit") {
      onExit();
      return;
    }
    if (result.kind === "loaded" && rows.length > 0) {
      navigate(action);
    }
  });

  return (
    <box
      backgroundColor={terminalBackground}
      flexDirection="column"
      height="100%"
      width="100%"
    >
      <box
        borderColor={theme.line}
        borderStyle="single"
        height={3}
        paddingX={1}
      >
        <text attributes={TextAttributes.BOLD} fg={theme.mint}>
          dv{" "}
          <span fg={theme.ink}>
            {target.server} / workspace: {target.workspace}
          </span>
        </text>
      </box>
      <box
        border
        borderColor={theme.line}
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        paddingX={1}
        title=" deployments "
        titleColor={theme.mint}
      >
        <scrollbox
          flexGrow={1}
          minHeight={0}
          ref={list}
          scrollbarOptions={scrollbarOptions}
        >
          {result.kind === "loading" && (
            <text fg={theme.muted}>Loading deployments…</text>
          )}
          {result.kind === "failed" && (
            <text fg={theme.rose}>
              Could not load deployments from this server. Run devver server
              status.
            </text>
          )}
          {result.kind === "unsupported" && (
            <text fg={theme.muted}>
              Deployment listing is unavailable on this server. Use a server
              created with a current build.
            </text>
          )}
          {result.kind === "loaded" && rows.length === 0 && (
            <text fg={theme.muted}>
              {target.repositoryId === undefined
                ? "No deployments on this server. Run devver deploy from a Git checkout."
                : "No deployments for this repository. Run devver deploy here."}
            </text>
          )}
          {rows.map((row): React.ReactNode =>
            treeRow(row, row.id === selectedId)
          )}
        </scrollbox>
      </box>
      <box
        borderColor={theme.line}
        borderStyle="single"
        flexDirection="row"
        height={3}
        justifyContent="space-between"
        paddingX={1}
      >
        <text
          fg={status === "" ? theme.muted : theme.rose}
          flexGrow={1}
          minWidth={0}
          wrapMode="none"
        >
          {status === "" ? "j/k/h/l move · o open · c copy · q quit" : status}
        </text>
        <text fg={theme.muted} wrapMode="none">
          {version !== undefined && version !== "" ? `v${version}` : ""}
        </text>
      </box>
    </box>
  );
}

function StandaloneApp({ version, onExit }: AppProps): React.ReactNode {
  useKeyboard((key) => {
    if (actionFor(key) === "quit") {
      onExit();
    }
  });

  const label = "No target selected";

  return (
    <box
      backgroundColor={terminalBackground}
      flexDirection="column"
      height="100%"
      width="100%"
    >
      <box
        borderColor={theme.line}
        borderStyle="single"
        height={3}
        paddingX={1}
      >
        <text attributes={TextAttributes.BOLD} fg={theme.mint}>
          dv <span fg={theme.ink}>{label}</span>
        </text>
      </box>
      <box
        border
        borderColor={theme.line}
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        paddingX={1}
        title=" deployments "
        titleColor={theme.mint}
      >
        <text fg={theme.muted}>
          Deployment browsing is not available yet. No deployment data has been
          loaded.
        </text>
      </box>
      <box
        borderColor={theme.line}
        borderStyle="single"
        flexDirection="row"
        height={3}
        justifyContent="space-between"
        paddingX={1}
      >
        <text fg={theme.muted} flexGrow={1}>
          q quit
        </text>
        <text fg={theme.muted}>
          {version !== undefined && version !== "" ? `v${version}` : ""}
        </text>
      </box>
    </box>
  );
}

export function App(props: AppProps): React.ReactNode {
  if (props.target.kind === "cloud") {
    return <CloudApp {...props} target={props.target} />;
  }
  return props.target.kind === "local" ? (
    <LocalApp {...props} target={props.target} />
  ) : (
    <StandaloneApp {...props} />
  );
}
