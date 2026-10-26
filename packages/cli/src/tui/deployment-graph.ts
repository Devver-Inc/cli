interface DeploymentRow {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly secondParentId: string | undefined;
}

interface MergeEdge {
  readonly at: number;
  readonly id: string;
  readonly parents: readonly string[];
}

interface Lane {
  readonly start: number;
  end: number;
  column: number;
}

interface Strokes {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  node: boolean;
}

/** One blank column between lanes keeps adjacent dots readable. */
const STRIDE = 2;

const GLYPHS = new Map([
  ["udlr", "┼"],
  ["udl", "┤"],
  ["udr", "├"],
  ["ulr", "┴"],
  ["dlr", "┬"],
  ["ud", "│"],
  ["ul", "┘"],
  ["ur", "└"],
  ["dl", "┐"],
  ["dr", "┌"],
  ["lr", "─"],
  ["u", "│"],
  ["d", "│"],
  ["l", "─"],
  ["r", "─"],
]);

function glyph(cell: Strokes) {
  if (cell.node) {
    return "●";
  }
  const key = `${cell.up ? "u" : ""}${cell.down ? "d" : ""}${cell.left ? "l" : ""}${cell.right ? "r" : ""}`;
  return GLYPHS.get(key) ?? " ";
}

// Parents must precede their merge; the primary-parent tree alone can put one below it.
function topological<T extends DeploymentRow>(rows: readonly T[]) {
  const pending = [...rows];
  const ordered: T[] = [];
  const visible = new Set(rows.map((row) => row.id));
  const placed = new Set<string>();
  while (pending.length > 0) {
    const ready = pending.find((row) =>
      [row.parentId, row.secondParentId].every(
        (parent) =>
          parent === undefined || !visible.has(parent) || placed.has(parent)
      )
    );
    // Cyclic lineage falls back to listing rows rather than hanging.
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

function mergeEdges(
  ordered: readonly DeploymentRow[],
  index: ReadonlyMap<string, number>
) {
  const edges: MergeEdge[] = [];
  for (const [at, row] of ordered.entries()) {
    const { parentId, secondParentId } = row;
    if (parentId === undefined || secondParentId === undefined) {
      continue;
    }
    const first = index.get(parentId);
    const second = index.get(secondParentId);
    // A parent outside the list, or below its own merge, gets no fabricated line.
    if (
      first === undefined ||
      second === undefined ||
      first >= at ||
      second >= at ||
      first === second
    ) {
      continue;
    }
    edges.push({ at, id: row.id, parents: [parentId, secondParentId] });
  }
  return edges;
}

/** A lane runs from a deployment's own row down to the last merge that consumes it. */
function laneColumns(
  merges: readonly MergeEdge[],
  index: ReadonlyMap<string, number>
) {
  const spans = new Map<string, Lane>();
  const touch = (id: string, until: number) => {
    const start = index.get(id);
    if (start === undefined) {
      return;
    }
    const existing = spans.get(id);
    if (existing === undefined) {
      spans.set(id, { start, end: until, column: 0 });
    } else {
      existing.end = Math.max(existing.end, until);
    }
  };
  for (const merge of merges) {
    touch(merge.id, merge.at);
    for (const parent of merge.parents) {
      touch(parent, merge.at);
    }
  }
  const freeFrom: number[] = [];
  for (const lane of [...spans.values()].toSorted(
    (a, b) => a.start - b.start
  )) {
    let column = 0;
    while ((freeFrom[column] ?? 0) > lane.start) {
      column += 1;
    }
    freeFrom[column] = lane.end + 1;
    lane.column = column;
  }
  return spans;
}

function connect(cells: readonly Strokes[], from: number, to: number) {
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
  lanes: ReadonlyMap<string, Lane>,
  merge: MergeEdge | undefined
) {
  const cells: Strokes[] = Array.from({ length: width }, () => ({
    up: false,
    down: false,
    left: false,
    right: false,
    node: false,
  }));
  for (const lane of lanes.values()) {
    const cell = cells[lane.column * STRIDE];
    if (cell === undefined) {
      continue;
    }
    if (at === lane.start) {
      cell.node = true;
      cell.down = lane.end > lane.start;
    } else if (at > lane.start && at < lane.end) {
      cell.up = true;
      cell.down = true;
    } else if (at === lane.end) {
      cell.up = true;
    }
  }
  const target = merge === undefined ? undefined : lanes.get(merge.id)?.column;
  if (merge !== undefined && target !== undefined) {
    for (const parent of merge.parents) {
      const from = lanes.get(parent)?.column;
      if (from !== undefined && from !== target) {
        connect(cells, from * STRIDE, target * STRIDE);
      }
    }
  }
  return cells.map(glyph).join("");
}

/**
 * Lane art for a deployment list, so a merge shows both its parents converging
 * on its own node instead of continuing one parent's line.
 */
export function deploymentGraph<T extends DeploymentRow>(rows: readonly T[]) {
  if (!rows.some((row) => row.secondParentId !== undefined)) {
    return rows.map((entry) => ({ entry, connector: "" }));
  }
  const ordered = topological(rows);
  const index = new Map(ordered.map((row, at) => [row.id, at]));
  const merges = mergeEdges(ordered, index);
  if (merges.length === 0) {
    return ordered.map((entry) => ({ entry, connector: "" }));
  }
  const lanes = laneColumns(merges, index);
  const columns = [...lanes.values()].map((lane) => lane.column);
  // shortcut: many concurrent lanes can push labels off a narrow terminal; add horizontal scrolling if that happens.
  const width = Math.max(...columns) * STRIDE + 1;
  return ordered.map((entry, at) => ({
    entry,
    connector: `${renderRow(
      at,
      width,
      lanes,
      merges.find((edge) => edge.at === at)
    )}  `,
  }));
}
