import { spawn } from "node:child_process";

function opener(url: string) {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

export async function openBrowser(url: string): Promise<boolean> {
  const { command, args } = opener(url);
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", () => {
      resolve(false);
    });
    child.once("close", (code) => {
      resolve(code === 0);
    });
  });
}
