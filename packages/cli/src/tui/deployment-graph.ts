interface DeploymentRow {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly secondParentId: string | undefined;
}

// Keep both visible parents above a merge; the primary-parent tree alone can put the other below it.
export function deploymentGraph<T extends DeploymentRow>(rows: readonly T[]) {
  if (!rows.some((row) => row.secondParentId !== undefined)) {
    return rows.map((entry) => ({ entry, connector: "" }));
  }
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

  const occupiedUntil: number[] = [];
  const connections: {
    start: number;
    later: number;
    end: number;
    slot: number;
  }[] = [];
  for (const [end, row] of ordered.entries()) {
    if (row.parentId === undefined || row.secondParentId === undefined) {
      continue;
    }
    const first = ordered.findIndex((entry) => entry.id === row.parentId);
    const second = ordered.findIndex(
      (entry) => entry.id === row.secondParentId
    );
    if (
      first === -1 ||
      second === -1 ||
      first >= end ||
      second >= end ||
      first === second
    ) {
      continue;
    }
    const start = Math.min(first, second);
    let slot = 0;
    while ((occupiedUntil[slot] ?? -1) >= start) {
      slot += 1;
    }
    occupiedUntil[slot] = end;
    connections.push({ start, later: Math.max(first, second), end, slot });
  }
  if (connections.length === 0) {
    return ordered.map((entry) => ({ entry, connector: "" }));
  }
  // shortcut: many overlapping merges can clip labels, add horizontal scrolling if that becomes common.
  const width = occupiedUntil.length * 4 - 1;
  return ordered.map((entry, index) => {
    const cells = Array.from({ length: width }, () => " ");
    for (const { start, later, end, slot } of connections) {
      const left = slot * 4;
      const right = left + 2;
      if (index === end) {
        cells[left] = "└";
        cells[left + 1] = "─";
        cells[right] = "●";
      } else if (index >= start && index < end) {
        cells[left] = index === start ? "●" : "│";
        if (index >= later) {
          cells[right] = index === later ? "●" : "│";
        }
      }
    }
    return { entry, connector: `${cells.join("")}  ` };
  });
}
