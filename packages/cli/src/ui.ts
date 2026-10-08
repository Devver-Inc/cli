import { EOL } from "node:os";
import readline from "node:readline";

const LOGO = [
  "█▀▀▄ █▀▀▀ █  █ █  █ █▀▀▀ █▀▀█",
  "█  █ █▀▀▀ █  █ █  █ █▀▀▀ █▀▀▄",
  "▀▀▀  ▀▀▀▀  ▀▀   ▀▀  ▀▀▀▀ ▀  ▀",
];

export const Style = {
  TEXT_HIGHLIGHT: "\u001B[96m",
  TEXT_HIGHLIGHT_BOLD: "\u001B[96m\u001B[1m",
  TEXT_DIM: "\u001B[90m",
  TEXT_DIM_BOLD: "\u001B[90m\u001B[1m",
  TEXT_NORMAL: "\u001B[0m",
  TEXT_NORMAL_BOLD: "\u001B[1m",
  TEXT_WARNING: "\u001B[93m",
  TEXT_WARNING_BOLD: "\u001B[93m\u001B[1m",
  TEXT_DANGER: "\u001B[91m",
  TEXT_DANGER_BOLD: "\u001B[91m\u001B[1m",
  TEXT_SUCCESS: "\u001B[92m",
  TEXT_SUCCESS_BOLD: "\u001B[92m\u001B[1m",
  TEXT_INFO: "\u001B[94m",
  TEXT_INFO_BOLD: "\u001B[94m\u001B[1m",
};

let blank = false;

export function print(...message: string[]) {
  blank = false;
  process.stderr.write(message.join(" "));
}

export function println(...message: string[]) {
  print(...message);
  process.stderr.write(EOL);
}

export function empty() {
  if (blank) {
    return;
  }
  println(Style.TEXT_NORMAL);
  blank = true;
}

export function logo(pad?: string) {
  const result: (string | null)[] = [];
  for (const row of LOGO) {
    if (pad !== undefined && pad !== "") {
      result.push(pad);
    }
    result.push(Style.TEXT_DIM, row, Style.TEXT_NORMAL, EOL);
  }
  return result.join("").trimEnd();
}

export async function input(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function error(message: string) {
  println(`${Style.TEXT_DANGER_BOLD}Error: ${Style.TEXT_NORMAL}${message}`);
}

export function markdown(text: string): string {
  return text;
}

export const UI = {
  Style,
  println,
  print,
  empty,
  logo,
  input,
  error,
  markdown,
};
