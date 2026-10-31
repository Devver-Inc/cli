import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import type React from "react";
import { useEffect, useRef, useState } from "react";

import type { shortcuts } from "../keys";
import type { CloudTarget } from "../target";
import { scrollbarOptions, theme } from "../theme";

export function useProjectSelection({
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

export function ProjectPicker({
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
