import { parentsOf } from "./lineage";
import type { LineageRow } from "./lineage";

const FALLOFF = [1, 0.85, 0.5, 0.28] as const;
const DISTANT = 0.15;

export function lineage(
  rows: readonly LineageRow[],
  selectedId: string | undefined
): ReadonlyMap<string, number> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const children = new Map<string, string[]>();
  for (const row of rows) {
    for (const parent of parentsOf(row)) {
      children.set(parent, [...(children.get(parent) ?? []), row.id]);
    }
  }
  const distances = new Map<string, number>();
  if (selectedId === undefined || !byId.has(selectedId)) {
    return distances;
  }
  distances.set(selectedId, 0);
  let frontier = [selectedId];
  for (let hop = 1; frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const row = byId.get(id);
      const related = [
        ...(row === undefined ? [] : parentsOf(row)),
        ...(children.get(id) ?? []),
      ];
      for (const neighbour of related) {
        if (!distances.has(neighbour) && byId.has(neighbour)) {
          distances.set(neighbour, hop);
          next.push(neighbour);
        }
      }
    }
    frontier = next;
  }
  return distances;
}

export function intensity(
  distance: number | undefined,
  progress: number,
  reach: number
) {
  if (distance === undefined) {
    return 0;
  }
  if (distance === 0) {
    return 1;
  }
  const lead = progress * (reach + 1);
  const arrived = Math.min(1, Math.max(0, lead - distance + 1));
  return arrived * (FALLOFF[distance] ?? DISTANT);
}

export function reachOf(distances: ReadonlyMap<string, number>) {
  return Math.max(1, ...distances.values());
}
