import { parentsOf } from "./lineage";
import type { LineageRow } from "./lineage";

type CellKind = "node" | "vertical" | "horizontal" | "junction" | "gap";

export interface Cell {
  readonly char: string;
  readonly kind: CellKind;
  readonly down: boolean;
  readonly lane: string | undefined;
}

export interface GraphRow<T> {
  readonly entry: T;
  readonly cells: readonly Cell[];
}

interface Strokes {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  node: boolean;
  lane: string | undefined;
}

interface Lane {
  readonly start: number;
  end: number;
  column: number;
}

// shortcut: concurrent lanes can push labels off a narrow terminal; add horizontal scrolling if that happens.
const STRIDE = 2;

const GLYPHS = new Map([
  ["udlr", "┼"],
  ["udl", "┤"],
  ["udr", "├"],
  ["ulr", "┴"],
  ["dlr", "┬"],
  ["ud", "│"],
  ["ul", "╯"],
  ["ur", "╰"],
  ["dl", "╮"],
  ["dr", "╭"],
  ["lr", "─"],
  ["u", "│"],
  ["d", "│"],
  ["l", "─"],
  ["r", "─"],
]);

function kindOf(cell: Strokes): CellKind {
  if (cell.node) {
    return "node";
  }
  const vertical = cell.up || cell.down;
  const horizontal = cell.left || cell.right;
  if (vertical && horizontal) {
    return "junction";
  }
  if (vertical) {
    return "vertical";
  }
  return horizontal ? "horizontal" : "gap";
}

function topological<T extends LineageRow>(rows: readonly T[]) {
  const pending = [...rows];
  const ordered: T[] = [];
  const visible = new Set(rows.map((row) => row.id));
  const placed = new Set<string>();
  while (pending.length > 0) {
    const ready = pending.find((row) =>
      parentsOf(row).every(
        (parent) => !visible.has(parent) || placed.has(parent)
      )
    );
    const next = ready ?? pending[0];
    if (next === undefined) {
      break;
    }
    ordered.push(next);
    placed.add(next.id);
    pending.splice(pending.indexOf(next), 1);
  }
  return ordered;
}

function firstFreeColumn(freeFrom: readonly number[], start: number) {
  let column = 0;
  while ((freeFrom[column] ?? 0) > start) {
    column += 1;
  }
  return column;
}

function laneColumns(ordered: readonly LineageRow[]) {
  const spans = new Map<string, Lane>();
  for (const [at, row] of ordered.entries()) {
    spans.set(row.id, { start: at, end: at, column: 0 });
  }
  for (const [at, row] of ordered.entries()) {
    for (const parent of parentsOf(row)) {
      const lane = spans.get(parent);
      if (lane !== undefined) {
        lane.end = Math.max(lane.end, at);
      }
    }
  }
  const freeFrom: number[] = [];
  for (const [id, lane] of [...spans].toSorted(
    ([, a], [, b]) => a.start - b.start
  )) {
    const parentId = ordered[lane.start]?.parentId;
    const inherited = parentId === undefined ? undefined : spans.get(parentId);
    const column =
      inherited !== undefined && inherited.end === lane.start
        ? inherited.column
        : firstFreeColumn(freeFrom, lane.start);
    freeFrom[column] = Math.max(freeFrom[column] ?? 0, lane.end + 1);
    spans.set(id, { ...lane, column });
  }
  return spans;
}

function connect(
  cells: readonly Strokes[],
  from: number,
  to: number,
  lane: string
) {
  const step = from < to ? 1 : -1;
  for (let x = from; x !== to; x += step) {
    const cell = cells[x];
    if (cell === undefined) {
      continue;
    }
    if (step > 0) {
      cell.right = true;
      cell.left ||= x !== from;
    } else {
      cell.left = true;
      cell.right ||= x !== from;
    }
    cell.lane ??= lane;
  }
  const arrival = cells[to];
  if (arrival === undefined) {
    return;
  }
  if (step > 0) {
    arrival.left = true;
  } else {
    arrival.right = true;
  }
}

function renderRow(
  at: number,
  width: number,
  row: LineageRow,
  nodeGlyph: string,
  lanes: ReadonlyMap<string, Lane>
): readonly Cell[] {
  const cells: Strokes[] = Array.from({ length: width }, () => ({
    up: false,
    down: false,
    left: false,
    right: false,
    node: false,
    lane: undefined,
  }));
  for (const [id, lane] of lanes) {
    const cell = cells[lane.column * STRIDE];
    if (cell === undefined || at < lane.start || at > lane.end) {
      continue;
    }
    cell.lane = id;
    cell.node ||= at === lane.start;
    cell.down ||= at < lane.end;
    cell.up ||= at > lane.start;
  }
  const own = lanes.get(row.id);
  if (own !== undefined) {
    for (const parent of parentsOf(row)) {
      const lane = lanes.get(parent);
      if (lane !== undefined && lane.column !== own.column) {
        connect(cells, lane.column * STRIDE, own.column * STRIDE, parent);
      }
    }
  }
  return cells.map((cell) => ({
    char: cell.node
      ? nodeGlyph
      : (GLYPHS.get(
          `${cell.up ? "u" : ""}${cell.down ? "d" : ""}${cell.left ? "l" : ""}${cell.right ? "r" : ""}`
        ) ?? " "),
    kind: kindOf(cell),
    down: cell.down,
    lane: cell.lane,
  }));
}

export function deploymentGraph<T extends LineageRow>(
  rows: readonly T[],
  glyphFor: (entry: T) => string
): readonly GraphRow<T>[] {
  const ordered = topological(rows);
  const lanes = laneColumns(ordered);
  const width =
    Math.max(0, ...[...lanes.values()].map((lane) => lane.column)) * STRIDE + 1;
  return ordered.map((entry, at) => ({
    entry,
    cells: renderRow(at, width, entry, glyphFor(entry), lanes),
  }));
}
