import { TextAttributes } from "@opentui/core";
import type React from "react";

import type { FlatDeployment } from "../deployments";
import type { Cell } from "../graph/deployment-graph";
import { intensity } from "../graph/focus";
import { shade, terminalBackground, theme } from "../theme";
import { gutter, laneCells, nodeFloor, STATUS_COLORS } from "./lanes";

function rowLabel(entry: FlatDeployment) {
  const named =
    entry.displayName === null ||
    entry.displayName === undefined ||
    entry.displayName === ""
      ? entry.id.slice(0, 8)
      : `${entry.displayName} (${entry.id.slice(0, 8)})`;
  const stage =
    entry.stage === null || entry.stage === undefined
      ? ""
      : ` (${entry.stage})`;
  const commit =
    entry.commit === undefined ? "" : `  ${entry.commit.slice(0, 8)}`;
  const depth = entry.secondParentId === undefined ? (entry.depth ?? 0) : 0;
  const branch = depth === 0 ? "" : `${"│ ".repeat(depth - 1)}└─ `;
  return `${branch}${named} ${entry.status}${stage}${commit}`;
}

function describe(entry: FlatDeployment | undefined) {
  return entry === undefined ? "–" : `${entry.id.slice(0, 8)} ${entry.status}`;
}

function echoFor(
  entry: FlatDeployment,
  current: FlatDeployment,
  distance: number | undefined
) {
  if (current.secondParentId !== undefined) {
    if (entry.id === current.parentId) {
      return "① parent";
    }
    if (entry.id === current.secondParentId) {
      return "② parent";
    }
  }
  if (distance !== 1) {
    return "";
  }
  if (entry.id === current.parentId || entry.id === current.secondParentId) {
    return "↑ parent";
  }
  const merged =
    entry.secondParentId !== undefined &&
    (entry.parentId === current.id || entry.secondParentId === current.id);
  return merged ? "⋈ merged here" : "↓ child";
}

function LineageCard({
  cells,
  entry,
  byId,
  lit,
}: {
  readonly cells: readonly Cell[];
  readonly entry: FlatDeployment;
  readonly byId: ReadonlyMap<string, FlatDeployment>;
  readonly lit: (lane: string | undefined) => number;
}): React.ReactNode {
  const bars = gutter(cells, lit);
  const children = [...byId.values()].filter(
    (other) => other.parentId === entry.id || other.secondParentId === entry.id
  );
  const parent =
    entry.parentId === undefined ? undefined : byId.get(entry.parentId);
  const from =
    entry.secondParentId === undefined
      ? `↑ ${parent === undefined ? "root · no parent" : describe(parent)}`
      : `① ${describe(parent)}   ·   ② ${describe(byId.get(entry.secondParentId))}`;
  const lines = [
    ["├ from ", from],
    [
      "├ url  ",
      entry.url === undefined
        ? "not reported by this server"
        : (entry.url ?? "none until ready"),
    ],
    [
      "╰ next ",
      children.length === 0
        ? "– leaf"
        : children.map((child) => describe(child)).join("   ·   "),
    ],
  ] as const;
  return (
    <box flexDirection="column" width="100%">
      {lines.map(([marker, body]): React.ReactNode => (
        <box flexDirection="row" height={1} key={marker} width="100%">
          <text wrapMode="none">
            {"  "}
            {bars}
            <span fg={shade(theme.mint, 0.85)}>{`  ${marker}`}</span>
            <span fg={shade(theme.ink, 0.8)}>{body}</span>
          </text>
        </box>
      ))}
    </box>
  );
}

export function DeploymentRow({
  cells,
  entry,
  current,
  focus,
  marked,
  byId,
}: {
  readonly cells: readonly Cell[];
  readonly entry: FlatDeployment;
  readonly current: FlatDeployment;
  readonly focus: {
    readonly distances: ReadonlyMap<string, number>;
    readonly progress: number;
    readonly reach: number;
  };
  readonly marked: boolean;
  readonly byId: ReadonlyMap<string, FlatDeployment>;
}): React.ReactNode {
  const selected = entry.id === current.id;
  const lit = intensity(
    focus.distances.get(entry.id),
    focus.progress,
    focus.reach
  );
  const laneLit = (lane: string | undefined) =>
    intensity(
      lane === undefined ? undefined : focus.distances.get(lane),
      focus.progress,
      focus.reach
    );
  let marker = " ";
  if (marked) {
    marker = selected ? "◈" : "✓";
  } else if (selected) {
    marker = "▸";
  }
  const echo = selected
    ? ""
    : echoFor(entry, current, focus.distances.get(entry.id));
  return (
    <box
      backgroundColor={marked ? theme.selection : terminalBackground}
      flexDirection="column"
      key={entry.id}
      width="100%"
    >
      <box flexDirection="row" height={1} width="100%">
        <text
          attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE}
          wrapMode="none"
        >
          <span fg={shade(theme.mint, marked || selected ? 1 : 0)}>
            {`${marker} `}
          </span>
          {laneCells(
            cells,
            laneLit,
            STATUS_COLORS[entry.status],
            nodeFloor(entry.status)
          )}
          <span
            fg={shade(selected ? theme.ink : theme.muted, Math.max(0.2, lit))}
          >
            {`  ${rowLabel(entry)}`}
          </span>
          <span fg={shade(theme.amber, lit)}>
            {echo === "" ? "" : `   ${echo}`}
          </span>
        </text>
      </box>
      {selected && (
        <LineageCard byId={byId} cells={cells} entry={entry} lit={laneLit} />
      )}
    </box>
  );
}
