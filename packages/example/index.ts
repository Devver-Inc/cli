import { normalizeTags } from "./lib/impl";

/** Normalize a list of tags for display. */
export function displayTags(tags: readonly string[]): string {
  return normalizeTags(tags).join(", ");
}
