export interface LineageRow {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly secondParentId: string | undefined;
}

export function parentsOf(row: LineageRow): string[] {
  return [row.parentId, row.secondParentId].filter(
    (parent): parent is string => parent !== undefined
  );
}
