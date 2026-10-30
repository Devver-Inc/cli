import type { KeyEvent } from "@opentui/core";

export const shortcuts = {
  down: ["j", "down"],
  up: ["k", "up"],
  left: ["h", "left"],
  right: ["l", "right"],
  open: ["o"],
  copy: ["c"],
  rename: ["r"],
  organization: ["g"],
  project: ["p"],
  confirm: ["return"],
  cancel: ["escape"],
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
    "left",
    "right",
    "open",
    "copy",
    "rename",
    "organization",
    "project",
    "confirm",
    "cancel",
    "quit",
  ] as const) {
    if (shortcuts[action].some((name) => name === key.name)) {
      return action;
    }
  }
  return undefined;
}
