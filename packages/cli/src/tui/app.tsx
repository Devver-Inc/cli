import { TextAttributes } from "@opentui/core";
import type {
  InputRenderable,
  KeyEvent,
  ScrollBoxRenderable,
} from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";

import { ApiError } from "../api/client";
import type { LocalDeploymentStatus } from "../api/local-deploy.requests";
import { openBrowser } from "../auth/browser";
import type { Candidate } from "../cli/update";
import { DeploymentDetails } from "./components/deployment-details";
import { DeploymentRow } from "./components/deployment-row";
import { glyphFor } from "./components/lanes";
import { ListPlaceholder } from "./components/list-placeholder";
import {
  OrganizationPicker,
  useOrganizationSelection,
} from "./components/organization-picker";
import {
  ProjectPicker,
  useProjectSelection,
} from "./components/project-picker";
import { useLineageWave } from "./components/wave";
import { buildTree, flatten, visibleDeployments } from "./deployments";
import type { FlatDeployment } from "./deployments";
import { deploymentGraph } from "./graph/deployment-graph";
import { lineage, reachOf } from "./graph/focus";
import { actionFor } from "./keys";
import type { shortcuts } from "./keys";
import type { AppProps, CloudTarget, LocalTarget } from "./target";
import { scrollbarOptions, terminalBackground, theme } from "./theme";

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
  update,
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
      {update !== undefined && (
        <text fg={theme.mint} wrapMode="none">
          {`devver --update · v${update.version} available`}
        </text>
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
          {org.orgError || shortcutHelp(org.orgPicker || projects.picker)}
        </text>
        <text fg={theme.muted} wrapMode="none">
          {version !== undefined && version !== "" ? `v${version}` : ""}
        </text>
      </box>
    </box>
  );
}

function copyUrl(
  entry: FlatDeployment | undefined,
  target: LocalTarget,
  setStatus: (message: string) => void
) {
  const url = entry?.url;
  if (
    entry?.status !== "ready" ||
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

function openUrl(
  entry: FlatDeployment | undefined,
  target: LocalTarget,
  setStatus: (message: string) => void
) {
  const url = entry?.url;
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
      opened ? `Opened ${url}` : "Could not open a browser for this deployment."
    );
  });
}

function isSameRevision(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 400 &&
    error.message.startsWith("Both deployments already have the same revision")
  );
}

function isRepeatedSelection(
  key: KeyEvent,
  action: keyof typeof shortcuts | undefined
) {
  return key.repeated === true && (action === "merge" || action === "select");
}

function hintFor({
  details,
  editing,
  merge,
  merged,
}: {
  readonly details: boolean;
  readonly editing: boolean;
  readonly merge: number;
  readonly merged: boolean;
}) {
  if (details) {
    return { hint: "Esc or d closes these details", more: "" };
  }
  if (editing) {
    return { hint: "Enter save · Esc cancel", more: "" };
  }
  if (merge > 0) {
    return {
      hint: `${merge}/2 selected · v toggle · m merge · Esc clear`,
      more: "",
    };
  }
  const more = "r rename · v select · m merge";
  return merged
    ? { hint: "1/h first parent · 2 second parent · d details · q quit", more }
    : { hint: "j/k/h/l move · d details · o open · c copy · q quit", more };
}

function LocalApp({
  update,
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
  const [mergeSelection, setMergeSelection] = useState<readonly string[]>([]);
  const [details, setDetails] = useState(false);
  const [merging, setMerging] = useState(false);
  const mergingRef = useRef(false);
  const [editor, setEditor] = useState<
    | { readonly kind: "idle" }
    | { readonly kind: "editing"; readonly id: string; readonly value: string }
    | { readonly kind: "saving"; readonly id: string }
  >({ kind: "idle" });
  const list = useRef<ScrollBoxRenderable>(null);
  const nameInput = useRef<InputRenderable>(null);

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

  const diagram = deploymentGraph(
    result.kind === "loaded"
      ? flatten(
          buildTree(
            visibleDeployments(result.deployments, target.repositoryId).map(
              (entry) => ({
                id: entry.deploymentId,
                displayName: entry.displayName,
                parentId: entry.parentDeploymentId ?? undefined,
                secondParentId: entry.secondParentDeploymentId ?? undefined,
                repositoryId: entry.repositoryId,
                commit: entry.commit,
                commitSubject: entry.commitSubject ?? undefined,
                createdAt: entry.createdAt,
                status: entry.status,
                stage: entry.stage,
                url: entry.url,
              })
            )
          )
        )
      : [],
    glyphFor
  );
  const rows = diagram.map(({ entry }) => entry);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const current = rows.find((row) => row.id === selectedId) ?? rows[0];
  const distances = lineage(rows, current?.id);
  const reach = reachOf(distances);
  const progress = useLineageWave(current?.id);

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

  function selectParent(action: "firstParent" | "secondParent") {
    const parent =
      action === "firstParent" ? current?.parentId : current?.secondParentId;
    if (parent !== undefined) {
      setSelectedId(parent);
    }
  }

  function navigate(action: keyof typeof shortcuts | undefined) {
    const found = rows.findIndex((row) => row.id === current?.id);
    const index = found === -1 ? 0 : found;
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
      const child = rows.find(
        (row) =>
          row.parentId === current?.id || row.secondParentId === current?.id
      );
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
    } else if (action === "firstParent" || action === "secondParent") {
      selectParent(action);
    } else if (action === "copy") {
      copyUrl(current, target, setStatus);
    } else if (action === "open") {
      openUrl(current, target, setStatus);
    }
  }

  function saveName(value: string, id: string) {
    const name = value.trim();
    if (
      name.length === 0 ||
      name.length > 80 ||
      // oxlint-disable-next-line no-control-regex -- Reject terminal escape and C0/C1 controls before sending.
      /[\u0000-\u001F\u007F-\u009F]/u.test(name)
    ) {
      setStatus("Name must be 1–80 characters without control characters.");
      return;
    }
    if (target.renameDeployment === undefined) {
      setStatus("This server does not support renaming deployments.");
      return;
    }
    setEditor({ kind: "saving", id });
    void target.renameDeployment(id, name).then(
      ({ displayName }) => {
        setResult((previous) =>
          previous.kind === "loaded"
            ? {
                kind: "loaded",
                deployments: previous.deployments.map((entry) =>
                  entry.deploymentId === id ? { ...entry, displayName } : entry
                ),
              }
            : previous
        );
        setEditor({ kind: "idle" });
        setStatus("Deployment renamed.");
      },
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejection is external; only the safe HTTP status is inspected.
      (error: unknown) => {
        setEditor({ kind: "editing", id, value });
        if (
          error instanceof Error &&
          "status" in error &&
          error.status === 405
        ) {
          setStatus("This server does not support renaming deployments.");
        } else if (
          error instanceof Error &&
          "status" in error &&
          error.status === 404
        ) {
          setStatus(
            "Deployment not found, or this server does not support renaming."
          );
        } else {
          setStatus("Could not rename deployment. Try again.");
        }
      }
    );
  }

  function confirmMerge() {
    if (mergingRef.current) {
      return;
    }
    const [first, second] = mergeSelection;
    if (first === undefined || second === undefined) {
      setStatus("Select two ready deployments with v before merging.");
      return;
    }
    if (target.mergeDeployments === undefined) {
      setStatus("This server does not support merging deployments.");
      return;
    }
    mergingRef.current = true;
    setMerging(true);
    void target.mergeDeployments(first, second).then(
      (merged) => {
        setResult((previous) =>
          previous.kind === "loaded"
            ? {
                kind: "loaded",
                deployments: [
                  ...previous.deployments,
                  {
                    ...merged,
                    displayName: null,
                    status: "ready",
                    stage: null,
                  },
                ],
              }
            : previous
        );
        setSelectedId(merged.deploymentId);
        setMergeSelection([]);
        mergingRef.current = false;
        setMerging(false);
        setStatus(
          `Merged ${merged.deploymentId.slice(0, 8)}. Press o to open.`
        );
      },
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejection is external; only the known HTTP error is inspected.
      (error: unknown) => {
        mergingRef.current = false;
        setMerging(false);
        setStatus(
          isSameRevision(error)
            ? "Both deployments already have the same revision"
            : "Merge failed. Check devver merge for details; both sources are unchanged."
        );
      }
    );
  }

  function toggleMergeSelection() {
    if (current === undefined) {
      return;
    }
    if (mergeSelection.includes(current.id)) {
      setMergeSelection(mergeSelection.filter((id) => id !== current.id));
      setStatus("Deployment deselected.");
      return;
    }
    if (current.status !== "ready" || current.repositoryId === undefined) {
      setStatus("Only ready deployments can be selected for merging.");
      return;
    }
    const first = rows.find((row) => row.id === mergeSelection[0]);
    if (first !== undefined && first.repositoryId !== current.repositoryId) {
      setStatus("Select deployments from the same repository.");
      return;
    }
    if (mergeSelection.length === 2) {
      setStatus("Two deployments are selected. Press v to deselect one.");
      return;
    }
    setMergeSelection([...mergeSelection, current.id]);
    setStatus(
      mergeSelection.length === 1
        ? "Two selected. Press m to merge, or Esc to clear selection."
        : "Select another ready deployment with v."
    );
  }

  function browse(action: keyof typeof shortcuts | undefined) {
    if (action === "details") {
      setDetails(current !== undefined);
    } else if (action === "select") {
      toggleMergeSelection();
    } else if (action === "merge") {
      confirmMerge();
    } else if (action === "rename" && current !== undefined) {
      setEditor({
        kind: "editing",
        id: current.id,
        value: current.displayName ?? "",
      });
      setStatus("");
    } else if (action !== "rename") {
      navigate(action);
    }
  }

  useKeyboard((key) => {
    const action = actionFor(key);
    if (isRepeatedSelection(key, action)) {
      return;
    }
    if (editor.kind !== "idle") {
      if (action === "cancel" && editor.kind === "editing") {
        key.preventDefault();
        setEditor({ kind: "idle" });
        setStatus("");
      } else if (action === "quit" && key.ctrl) {
        onExit();
      }
      return;
    }
    if (action === "quit") {
      onExit();
      return;
    }
    if (mergingRef.current) {
      return;
    }
    if (action === "cancel" && mergeSelection.length > 0) {
      setMergeSelection([]);
      setStatus("Merge selection cleared.");
      return;
    }
    if (details) {
      if (action === "details" || action === "cancel") {
        setDetails(false);
      }
      return;
    }
    if (result.kind === "loaded" && rows.length > 0) {
      browse(action);
    }
  });

  const { hint, more } = hintFor({
    details,
    editing: editor.kind === "editing",
    merge: mergeSelection.length,
    merged: current?.secondParentId !== undefined,
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
          <ListPlaceholder
            empty={rows.length === 0}
            kind={result.kind}
            repositoryId={target.repositoryId}
          />
          {current !== undefined &&
            diagram.map(({ entry, cells }): React.ReactNode => (
              <DeploymentRow
                byId={byId}
                cells={cells}
                current={current}
                entry={entry}
                key={entry.id}
                focus={{ distances, progress, reach }}
                marked={mergeSelection.includes(entry.id)}
              />
            ))}
        </scrollbox>
      </box>
      {details && current !== undefined && (
        <DeploymentDetails byId={byId} entry={current} />
      )}
      {editor.kind === "editing" && (
        <box height={1} flexDirection="row">
          <text fg={theme.mint}>Rename: </text>
          <input
            flexGrow={1}
            focused
            ref={nameInput}
            maxLength={80}
            value={editor.value}
            onInput={(value) => {
              setEditor((previous) =>
                previous.kind === "editing" ? { ...previous, value } : previous
              );
            }}
            onSubmit={() => {
              saveName(nameInput.current?.value ?? editor.value, editor.id);
            }}
          />
        </box>
      )}
      {editor.kind === "saving" && <text fg={theme.muted}>Saving name…</text>}
      {merging && <text fg={theme.muted}>Merging deployments…</text>}
      {update !== undefined && (
        <text fg={theme.mint} wrapMode="none">
          {`devver --update · v${update.version} available`}
        </text>
      )}
      <box
        borderColor={theme.line}
        borderStyle="single"
        flexDirection="column"
        height={4}
        paddingX={1}
      >
        <box flexDirection="row" height={1} justifyContent="space-between">
          <text
            fg={status === "" ? theme.muted : theme.rose}
            flexGrow={1}
            minWidth={0}
            wrapMode="none"
          >
            {status || hint}
          </text>
          <text fg={theme.muted} wrapMode="none">
            {version !== undefined && version !== "" ? `v${version}` : ""}
          </text>
        </box>
        <text fg={theme.muted} height={1} wrapMode="none">
          {more}
        </text>
      </box>
    </box>
  );
}

function StandaloneApp({ version, update, onExit }: AppProps): React.ReactNode {
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
      {update !== undefined && (
        <text fg={theme.mint} wrapMode="none">
          {`devver --update · v${update.version} available`}
        </text>
      )}
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
  const [update, setUpdate] = useState<Candidate | undefined>();
  useEffect(() => {
    let active = true;
    void props.checkUpdate?.().then(
      (candidate) => {
        if (active) {
          setUpdate(candidate);
        }
      },
      () => {
        if (active) {
          setUpdate(undefined);
        }
      }
    );
    return () => {
      active = false;
    };
  }, [props.checkUpdate]);
  const displayProps = { ...props, update };
  if (props.target.kind === "cloud") {
    return <CloudApp {...displayProps} target={props.target} />;
  }
  return props.target.kind === "local" ? (
    <LocalApp {...displayProps} target={props.target} />
  ) : (
    <StandaloneApp {...displayProps} />
  );
}
