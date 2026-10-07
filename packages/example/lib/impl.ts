export function normalizeTags(tags: readonly string[]): string[] {
  return [
    ...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)),
  ].sort();
}
