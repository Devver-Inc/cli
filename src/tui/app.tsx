import type { KeyEvent } from "@opentui/core";
import { RGBA, type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import type { Organization } from "../auth/session";
import { actionFor, type shortcuts } from "./keys";
import { statuses, theme } from "./theme";

const terminalBackground = RGBA.defaultBackground();
const scrollbarOptions = {
  trackOptions: {
    backgroundColor: terminalBackground,
    foregroundColor: theme.muted,
  },
};

const deployments = [
  {
    id: "main",
    name: "main",
    parent: null,
    status: "stable",
    commit: "9d8e7f",
    age: "2h",
    branch: "main",
    url: "https://storefront.devver.app",
    comments: [["Maya", "1 hour ago", "/", "Landing page looks good to ship."]],
  },
  {
    id: "checkout",
    name: "checkout",
    parent: "main",
    status: "testing",
    commit: "a1b2c3",
    age: "8m",
    branch: "feature/checkout",
    url: "https://checkout.storefront.devver.app",
    comments: [
      [
        "Alex",
        "7 minutes ago",
        "/checkout",
        "Can we test a shorter button label?",
      ],
      [
        "Maya",
        "8 minutes ago",
        "/checkout · mobile",
        "Button overlaps the footer on my phone.",
      ],
    ],
  },
  {
    id: "copy",
    name: "shorter copy",
    parent: "checkout",
    status: "review",
    commit: "c29a615",
    age: "3m",
    branch: "feature/checkout-copy",
    url: "https://checkout-copy.storefront.devver.app",
    comments: [
      [
        "Maya",
        "2 minutes ago",
        "/checkout · Place order button",
        "Much clearer. Could we make the delivery date visible here?",
      ],
      [
        "Alex",
        "4 minutes ago",
        "/checkout · order summary",
        "This version reads better than the original.",
      ],
      [
        "Maya",
        "6 minutes ago",
        "/checkout · mobile",
        "The button still overlaps the footer on my phone.",
      ],
    ],
  },
  {
    id: "contrast",
    name: "high contrast",
    parent: "copy",
    status: "idea",
    commit: "73e2d41",
    age: "1m",
    branch: "feature/high-contrast",
    url: "https://contrast.storefront.devver.app",
    comments: [],
  },
  {
    id: "flow",
    name: "one-page flow",
    parent: "checkout",
    status: "idea",
    commit: "e19f024",
    age: "1m",
    branch: "feature/one-page-flow",
    url: "https://one-page.storefront.devver.app",
    comments: [
      [
        "Alex",
        "just now",
        "/checkout",
        "This feels faster, but where did the order summary go?",
      ],
    ],
  },
  {
    id: "summary",
    name: "inline summary",
    parent: "flow",
    status: "review",
    commit: "7c1a088",
    age: "now",
    branch: "feature/inline-summary",
    url: "https://summary.storefront.devver.app",
    comments: [],
  },
  {
    id: "mobile",
    name: "mobile nav",
    parent: "main",
    status: "stable",
    commit: "34fa10",
    age: "1d",
    branch: "fix/mobile",
    url: "https://mobile.storefront.devver.app",
    comments: [],
  },
  {
    id: "thumb",
    name: "thumb-friendly",
    parent: "mobile",
    status: "testing",
    commit: "8a2f044",
    age: "5h",
    branch: "fix/thumb-nav",
    url: "https://thumb-nav.storefront.devver.app",
    comments: [
      ["Alex", "2 hours ago", "/menu", "Much easier to reach with one hand."],
    ],
  },
  {
    id: "onboarding",
    name: "onboarding",
    parent: "main",
    status: "testing",
    commit: "f8b290c",
    age: "4h",
    branch: "feature/onboarding",
    url: "https://onboarding.storefront.devver.app",
    comments: [
      [
        "Maya",
        "3 hours ago",
        "/welcome",
        "Could the intro be one step shorter?",
      ],
    ],
  },
  {
    id: "welcome",
    name: "two-step welcome",
    parent: "onboarding",
    status: "review",
    commit: "20a0d8b",
    age: "2h",
    branch: "feature/two-step-welcome",
    url: "https://welcome.storefront.devver.app",
    comments: [],
  },
] as const;

type Deployment = (typeof deployments)[number];

function node(id: string): Deployment | undefined {
  return deployments.find((item) => item.id === id);
}

// A prefix is built from actual ancestry, not manually positioned glyphs.
function edge(item: Deployment): string {
  if (!item.parent) {
    return "╭── ";
  }
  const parents: Deployment[] = [];
  let parent = node(item.parent);
  while (parent) {
    parents.unshift(parent);
    parent = parent.parent ? node(parent.parent) : undefined;
  }
  const trunk = parents
    .slice(1)
    .map((ancestor) =>
      deployments.some(
        (sibling) =>
          sibling.parent === ancestor.parent &&
          deployments.indexOf(sibling) > deployments.indexOf(ancestor)
      )
        ? "│  "
        : "   "
    )
    .join("");
  const last = !deployments.some(
    (sibling) =>
      sibling.parent === item.parent &&
      deployments.indexOf(sibling) > deployments.indexOf(item)
  );
  return `${trunk}${last ? "└──" : "├──"} `;
}

export interface AppProps {
  readonly directory?: string;
  readonly project?: string;
  readonly currentProjectId?: string | null;
  readonly loadProjects?: () => Promise<
    readonly { id: string; name: string }[]
  >;
  readonly onSwitchProject?: (id: string) => Promise<void>;
  readonly version?: string;
  readonly organizations?: readonly Organization[];
  readonly currentOrganization?: string | null;
  readonly onSwitchOrganization?: (
    current: string | null,
    id: string
  ) => Promise<void>;
  readonly onExit: () => void;
}

function ancestorIds(item: Deployment): Set<string> {
  const ancestors = new Set<string>();
  let ancestor = item.parent ? node(item.parent) : undefined;
  while (ancestor) {
    ancestors.add(ancestor.id);
    ancestor = ancestor.parent ? node(ancestor.parent) : undefined;
  }
  return ancestors;
}

function Feedback({ item }: { readonly item: Deployment }) {
  if (item.comments.length === 0) {
    return <text fg={theme.muted}>No feedback on this preview yet.</text>;
  }
  return item.comments.map(([author, time, location, message]) => (
    <box flexDirection="column" key={`${author}-${time}`} paddingTop={1}>
      <text fg={theme.amber}>
        {author} <span fg={theme.muted}>{time}</span>
      </text>
      <text fg={theme.muted}>{location}</text>
      <text fg={theme.ink}>{message}</text>
    </box>
  ));
}

function Diff({
  item,
  baseItem,
}: {
  readonly item: Deployment;
  readonly baseItem: Deployment;
}) {
  if (item.id === baseItem.id) {
    return (
      <text fg={theme.muted}>
        Select another deployment to see what changed.
      </text>
    );
  }
  let label = "Continue";
  if (item.id === "flow") {
    label = "Complete order";
  } else if (item.id === "copy") {
    label = "Place order";
  }
  return (
    <box flexDirection="column" paddingTop={1}>
      <text fg={theme.muted}>
        Compared with {baseItem.name} · {baseItem.commit}
      </text>
      <text fg={theme.blue}>src/app/checkout.tsx</text>
      <text fg={theme.muted}>
        @@ {baseItem.commit} → {item.commit} @@
      </text>
      <text fg={theme.rose}>
        - &lt;Button&gt;Continue to payment&lt;/Button&gt;
      </text>
      <text fg={theme.mint}>+ &lt;Button&gt;{label}&lt;/Button&gt;</text>
      <text fg={theme.muted}>Illustrative diff · no files fetched</text>
    </box>
  );
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
    (orgId ? undefined : organizations[0]);

  useEffect(() => {
    if (!orgError) {
      return;
    }
    const timer = setTimeout(() => setOrgError(""), 4000);
    return () => clearTimeout(timer);
  }, [orgError]);

  useEffect(() => {
    if (!orgPicker) {
      return;
    }
    const choice = organizations[orgIndex];
    const timer = setTimeout(() => {
      if (choice) {
        orgList.current?.scrollChildIntoView(`organization-${choice.id}`);
      }
    }, 0);
    return () => clearTimeout(timer);
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
    switch (action) {
      case "cancel":
        setOrgPicker(false);
        break;
      case "up":
        setOrgIndex((index) => Math.max(0, index - 1));
        break;
      case "down":
        setOrgIndex((index) => Math.min(organizations.length - 1, index + 1));
        break;
      case "confirm": {
        const choice = organizations[orgIndex];
        if (!(choice && onSwitchOrganization)) {
          break;
        }
        if (choice.id === currentOrg?.id) {
          setOrgPicker(false);
          break;
        }
        switchingRef.current = true;
        setSwitching(true);
        setOrgError("");
        setOrgId(choice.id);
        setOrgPicker(false);
        onSwitchOrganization(orgId, choice.id)
          .then(
            () => setConfirmedId(choice.id),
            () => {
              setOrgId(orgId);
              setOrgError(
                "Could not switch organization. Check your selection."
              );
            }
          )
          .finally(() => {
            switchingRef.current = false;
            setSwitching(false);
          });
        break;
      }
      case "quit":
        if (key.ctrl) {
          onExit();
        }
        break;
      default:
        break;
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
  readonly currentOrg?: Organization;
  readonly orgIndex: number;
  readonly orgList: React.RefObject<ScrollBoxRenderable | null>;
  readonly switching: boolean;
  readonly orgError: string;
}) {
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
        {organizations.map((org, index) => (
          <text
            attributes={index === orgIndex ? TextAttributes.BOLD : undefined}
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
      {orgError && <text fg={theme.rose}>{orgError}</text>}
    </box>
  );
}

function DeploymentDetails({
  item,
  baseItem,
  tab,
  compact,
}: {
  readonly item: Deployment;
  readonly baseItem: Deployment;
  readonly tab: "feedback" | "diff";
  readonly compact: boolean;
}) {
  return (
    <box
      border
      borderColor={theme.line}
      flexBasis={0}
      flexDirection="column"
      flexGrow={compact ? 1 : 4}
      minWidth={0}
      paddingX={1}
      title=" selected deployment "
      titleColor={theme.mint}
    >
      <text
        attributes={TextAttributes.BOLD}
        fg={theme.ink}
        flexShrink={0}
        height={1}
        wrapMode="none"
      >
        {item.name} ● {item.status}
      </text>
      <text fg={theme.muted} flexShrink={0} height={1} wrapMode="none">
        branch {item.branch}
      </text>
      <text fg={theme.muted} flexShrink={0} height={1} wrapMode="none">
        commit {item.commit}
      </text>
      <text fg={theme.mint} flexShrink={0} height={1} wrapMode="none">
        preview {item.url}
      </text>
      <text fg={theme.muted} flexShrink={0} height={1} wrapMode="none">
        parent {item.parent ? node(item.parent)?.name : "—"}
      </text>
      <box flexDirection="row" flexShrink={0} height={2} paddingTop={1}>
        <text fg={tab === "feedback" ? theme.mint : theme.muted}>
          feedback {item.comments.length}{" "}
        </text>
        <text fg={tab === "diff" ? theme.mint : theme.muted}>
          diff ↔ {baseItem.name}
        </text>
      </box>
      <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={scrollbarOptions}>
        {tab === "feedback" ? (
          <Feedback item={item} />
        ) : (
          <Diff baseItem={baseItem} item={item} />
        )}
      </scrollbox>
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
  organizationId?: string;
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
    if (!(loadProjects && organizationId)) {
      setProjects([]);
      return;
    }
    let active = true;
    setError("");
    setLoading(true);
    setProjects([]);
    if (organizationId !== initialOrganizationId) {
      setProjectId(null);
    }
    loadProjects().then(
      (result) => {
        if (active) {
          setProjects(result);
          setLoading(false);
        }
      },
      () => {
        if (active) {
          setError("Could not load projects. Reopen the selector to retry.");
          setLoading(false);
        }
      }
    );
    return () => {
      active = false;
    };
  }, [organizationId, loadProjects, initialOrganizationId]);

  useEffect(() => {
    if (!picker) {
      return;
    }
    const choice = projects[index];
    const timer = setTimeout(() => {
      if (choice) {
        list.current?.scrollChildIntoView(`project-${choice.id}`);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [picker, index, projects]);

  function open() {
    setIndex(
      Math.max(
        0,
        projects.findIndex((entry) => entry.id === projectId)
      )
    );
    setPicker(true);
    if (loadProjects && organizationId) {
      setError("");
      setLoading(true);
      loadProjects().then(
        (result) => {
          setProjects(result);
          setLoading(false);
        },
        () => {
          setError("Could not load projects. Try again.");
          setLoading(false);
        }
      );
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
    switch (action) {
      case "cancel":
        setPicker(false);
        break;
      case "up":
        setIndex((value) => Math.max(0, value - 1));
        break;
      case "down":
        setIndex((value) => Math.min(projects.length - 1, value + 1));
        break;
      case "confirm": {
        const choice = projects[index];
        if (!(choice && onSwitchProject)) {
          break;
        }
        if (choice.id === projectId) {
          setPicker(false);
          break;
        }
        busyRef.current = true;
        setBusy(true);
        onSwitchProject(choice.id)
          .then(
            () => {
              setProjectId(choice.id);
              setPicker(false);
            },
            () => setError("Could not switch project. Try again.")
          )
          .finally(() => {
            busyRef.current = false;
            setBusy(false);
          });
        break;
      }
      case "quit":
        if (key.ctrl) {
          onExit();
        }
        break;
      default:
        break;
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
}: ReturnType<typeof useProjectSelection>) {
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
        {!loading && projects.length === 0 && !error && (
          <text fg={theme.muted}>
            No projects available in this organization.
          </text>
        )}
        {projects.map((entry, position) => (
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
      {error && <text fg={theme.rose}>{error}</text>}
    </box>
  );
}

function headerLabels(
  org: ReturnType<typeof useOrganizationSelection>,
  projects: ReturnType<typeof useProjectSelection>,
  project: string | undefined,
  hasProjectLoader: boolean
) {
  const organization =
    org.currentOrg?.name ??
    (org.orgId ? `Unknown (${org.orgId})` : "No organization");
  const selectedProject = projects.projects.find(
    (entry) => entry.id === projects.projectId
  )?.name;
  const projectName = org.switching
    ? "Switching organization…"
    : (selectedProject ??
      (hasProjectLoader ? "Select project" : (project ?? "storefront")));
  return `${organization} / ${projectName}`;
}

function shortcutHelp(compact: boolean, pickerOpen: boolean) {
  if (pickerOpen) {
    return "j/k ↑/↓ move · Enter select · Esc cancel";
  }
  return compact
    ? "j/k move · Tab pane · f/d · b · g org · p project · q"
    : "j/k ↑/↓ move · f/d tabs · b base · g org · p project · q quit";
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
}: AppProps) {
  const { width } = useTerminalDimensions();
  const compact = width < 100;
  const [selected, setSelected] = useState(2);
  const [pane, setPane] = useState<"tree" | "details">("tree");
  const [tab, setTab] = useState<"feedback" | "diff">("feedback");
  const [base, setBase] = useState(1);
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
  const tree = useRef<ScrollBoxRenderable>(null);
  const item = deployments[selected] ?? deployments[0];
  const baseItem = deployments[base] ?? deployments[0];
  const ancestors = ancestorIds(item);
  const visibleTree = !compact || pane === "tree";
  const help = shortcutHelp(compact, org.orgPicker || projects.picker);
  let pickerView: React.ReactNode;
  if (org.orgPicker) {
    pickerView = <OrganizationPicker {...org} organizations={organizations} />;
  } else if (projects.picker) {
    pickerView = <ProjectPicker {...projects} />;
  }

  useEffect(() => {
    if (!visibleTree) {
      return;
    }
    const timer = setTimeout(
      () => tree.current?.scrollChildIntoView(`deployment-${item.id}`),
      0
    );
    return () => clearTimeout(timer);
  }, [item.id, visibleTree]);

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
    switch (action) {
      case "organization":
        org.open();
        break;
      case "project":
        projects.open();
        break;
      case "quit":
        onExit();
        break;
      case "down":
        setSelected((index) => Math.min(deployments.length - 1, index + 1));
        break;
      case "up":
        setSelected((index) => Math.max(0, index - 1));
        break;
      case "feedback":
        setTab("feedback");
        break;
      case "diff":
        setTab("diff");
        break;
      case "base":
        setBase(selected);
        setTab("diff");
        break;
      case "pane":
        if (compact) {
          setPane((current) => (current === "tree" ? "details" : "tree"));
        }
        break;
      default:
        break;
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
        {!compact && <text fg={theme.muted}>● mock data</text>}
      </box>
      <text fg={theme.ink} height={2} paddingLeft={1}>
        Deployments <span fg={theme.muted}>/ explore what changed</span>
      </text>
      {pickerView ?? (
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          {visibleTree && (
            <box
              border
              borderColor={theme.line}
              flexBasis={0}
              flexDirection="column"
              flexGrow={compact ? 1 : 6}
              minWidth={0}
              title=" deployment tree "
              titleColor={theme.mint}
            >
              <text fg={theme.muted} paddingLeft={1}>
                ◆ selected · {deployments.length} previews
              </text>
              <scrollbox
                flexGrow={1}
                minHeight={0}
                ref={tree}
                scrollbarOptions={scrollbarOptions}
              >
                {deployments.map((entry, index) => {
                  const active = selected === index;
                  const path = ancestors.has(entry.id);
                  return (
                    <box
                      flexDirection="row"
                      height={1}
                      id={`deployment-${entry.id}`}
                      key={entry.id}
                      paddingLeft={1}
                    >
                      <text
                        fg={active || path ? theme.mint : theme.muted}
                        wrapMode="none"
                      >
                        {active ? "◆ " : "  "}
                        {edge(entry)}
                      </text>
                      <text
                        attributes={active ? TextAttributes.BOLD : undefined}
                        fg={theme.ink}
                        wrapMode="none"
                      >
                        <span fg={statuses[entry.status]}>●</span> {entry.name}{" "}
                        <span fg={theme.muted}>
                          {entry.commit} · {entry.age}
                        </span>{" "}
                        <span fg={statuses[entry.status]}>
                          [{entry.status}]
                        </span>
                      </text>
                    </box>
                  );
                })}
              </scrollbox>
              <text fg={theme.muted} paddingLeft={1}>
                <span fg={theme.mint}>●</span> stable{" "}
                <span fg={theme.amber}>●</span> testing{" "}
                <span fg={theme.blue}>●</span> review{" "}
                <span fg={theme.rose}>●</span> idea
              </text>
            </box>
          )}
          {(!compact || pane === "details") && (
            <DeploymentDetails
              baseItem={baseItem}
              compact={compact}
              item={item}
              tab={tab}
            />
          )}
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
          fg={org.orgError ? theme.rose : theme.muted}
          flexGrow={1}
          minWidth={0}
          wrapMode="none"
        >
          {org.orgError || help}
        </text>
        <text fg={theme.muted} wrapMode="none">
          {version ? `v${version}` : ""}
        </text>
      </box>
    </box>
  );
}
