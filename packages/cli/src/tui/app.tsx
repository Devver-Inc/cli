import { RGBA, TextAttributes } from "@opentui/core";
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";

import type { Organization } from "../auth/session";
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

export interface AppProps {
  readonly project?: string | undefined;
  readonly currentProjectId?: string | null | undefined;
  readonly loadProjects?:
    | (() => Promise<readonly { id: string; name: string }[]>)
    | undefined;
  readonly onSwitchProject?: ((id: string) => Promise<void>) | undefined;
  readonly version?: string | undefined;
  readonly organizations?: readonly Organization[] | undefined;
  readonly currentOrganization?: string | null | undefined;
  readonly onSwitchOrganization?:
    | ((current: string | null, id: string) => Promise<void>)
    | undefined;
  readonly onExit: () => void;
}

function useOrganizationSelection({
  organizations = [],
  currentOrganization = null,
  onSwitchOrganization,
}: Pick<
  AppProps,
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
}: Pick<AppProps, "currentProjectId" | "loadProjects" | "onSwitchProject"> & {
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
      loadProjects()
        .then((result) => {
          setProjects(result);
          setLoading(false);
        })
        .catch(() => {
          setError("Could not load projects. Try again.");
          setLoading(false);
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

export function App({
  project,
  currentProjectId = null,
  loadProjects,
  onSwitchProject,
  version,
  organizations = [],
  currentOrganization = null,
  onSwitchOrganization,
  onExit,
}: AppProps): React.ReactNode {
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
