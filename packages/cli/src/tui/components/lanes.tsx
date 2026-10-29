import type React from "react";

import type { FlatDeployment } from "../deployments";
import type { Cell } from "../graph/deployment-graph";
import { shade, theme } from "../theme";

const SOLID_AT = 0.45;

const DASHED = new Map([
  ["│", "╎"],
  ["─", "╌"],
]);

const STATUS_GLYPHS = {
  ready: "●",
  preparing: "◐",
  degraded: "◍",
  failed: "✕",
} as const;

export const STATUS_COLORS = {
  ready: theme.mint,
  preparing: theme.amber,
  degraded: theme.amber,
  failed: theme.rose,
} as const;

export function glyphFor(entry: FlatDeployment) {
  return entry.secondParentId === undefined ? STATUS_GLYPHS[entry.status] : "◆";
}

export function nodeFloor(status: FlatDeployment["status"]) {
  return status === "failed" || status === "degraded" ? 0.6 : 0.32;
}

export function laneCells(
  cells: readonly Cell[],
  lit: (lane: string | undefined) => number,
  statusColor: string,
  floor: number
): readonly React.ReactNode[] {
  return cells.map((cell, at): React.ReactNode => {
    const value = lit(cell.lane);
    const char =
      value < SOLID_AT ? (DASHED.get(cell.char) ?? cell.char) : cell.char;
    const node = cell.kind === "node";
    return (
      <span
        fg={shade(
          node ? statusColor : theme.muted,
          node ? Math.max(floor, value) : value
        )}
        key={`${at}-${cell.char}`}
      >
        {char}
      </span>
    );
  });
}

export function gutter(
  cells: readonly Cell[],
  lit: (lane: string | undefined) => number
): readonly React.ReactNode[] {
  return cells.map((cell, at): React.ReactNode => {
    const value = lit(cell.lane);
    const char = cell.down || cell.kind === "node" ? "│" : " ";
    return (
      <span fg={shade(theme.muted, value)} key={`${at}-gutter`}>
        {value < SOLID_AT ? (DASHED.get(char) ?? char) : char}
      </span>
    );
  });
}
