import type { KeyEvent } from "@opentui/core";

// Keep actions separate from physical keys so remapping can be added later.
export const shortcuts = {
  down: ["j", "down"],
  up: ["k", "up"],
  feedback: ["f"],
  diff: ["d"],
  base: ["b"],
  pane: ["tab"],
  quit: ["q"],
} as const;

export function actionFor(key: KeyEvent): keyof typeof shortcuts | undefined {
  if (key.ctrl && key.name === "c") {
    return "quit";
  }
  if (key.ctrl || key.meta || key.option || key.shift) {
    return undefined;
  }
  for (const action of [
    "down",
    "up",
    "feedback",
    "diff",
    "base",
    "pane",
    "quit",
  ] as const) {
    if (shortcuts[action].some((name) => name === key.name)) {
      return action;
    }
  }
  return undefined;
}
