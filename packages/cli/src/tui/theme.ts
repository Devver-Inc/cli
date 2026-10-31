import { RGBA } from "@opentui/core";

export const theme = {
  line: "#56615d",
  ink: "#ded9cb",
  muted: "#9daaa3",
  mint: "#9ad2b5",
  amber: "#f0c67b",
  rose: "#e4a5a3",
  selection: "#33443c",
} as const;

function channels(hex: string) {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
}

export function shade(hex: string, lit: number) {
  const from = channels(theme.line);
  const to = channels(hex);
  const mixed = to.map((value, at) => {
    const base = from[at] ?? 0;
    return Math.round(base + (value - base) * Math.min(1, Math.max(0, lit)));
  });
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export const terminalBackground = RGBA.defaultBackground();
export const scrollbarOptions = {
  trackOptions: {
    backgroundColor: terminalBackground,
    foregroundColor: theme.muted,
  },
};
