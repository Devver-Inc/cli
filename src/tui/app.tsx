import { RGBA, type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { actionFor } from "./keys";
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
  readonly version?: string;
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

export function App({ project, version, onExit }: AppProps) {
  const { width } = useTerminalDimensions();
  const compact = width < 100;
  const [selected, setSelected] = useState(2);
  const [pane, setPane] = useState<"tree" | "details">("tree");
  const [tab, setTab] = useState<"feedback" | "diff">("feedback");
  const [base, setBase] = useState(1);
  const tree = useRef<ScrollBoxRenderable>(null);
  const item = deployments[selected] ?? deployments[0];
  const baseItem = deployments[base] ?? deployments[0];
  const ancestors = ancestorIds(item);
  const visibleTree = !compact || pane === "tree";

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
    switch (actionFor(key)) {
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
          dv <span fg={theme.ink}>acme / {project ?? "storefront"}</span>
        </text>
        {!compact && <text fg={theme.muted}>● mock data</text>}
      </box>
      <text fg={theme.ink} height={2} paddingLeft={1}>
        Deployments <span fg={theme.muted}>/ explore what changed</span>
      </text>
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
                      <span fg={statuses[entry.status]}>[{entry.status}]</span>
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
            <scrollbox
              flexGrow={1}
              minHeight={0}
              scrollbarOptions={scrollbarOptions}
            >
              {tab === "feedback" ? (
                <Feedback item={item} />
              ) : (
                <Diff baseItem={baseItem} item={item} />
              )}
            </scrollbox>
          </box>
        )}
      </box>
      <box
        borderColor={theme.line}
        borderStyle="single"
        flexDirection="row"
        height={3}
        justifyContent="space-between"
        paddingX={1}
      >
        <text fg={theme.muted} flexGrow={1} minWidth={0} wrapMode="none">
          {compact
            ? "j/k move · Tab pane · f/d · b · q"
            : "j/k ↑/↓ move · f/d tabs · b base · q quit"}
        </text>
        <text fg={theme.muted} wrapMode="none">
          {version ? `v${version}` : ""}
        </text>
      </box>
    </box>
  );
}
