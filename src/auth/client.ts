import { Rpc } from "../util/rpc";
import type { rpc } from "./worker";

let worker: Worker | undefined;
let client: ReturnType<typeof Rpc.client<typeof rpc>> | undefined;

export function getAuthClient() {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url));
    worker.onerror = (e) => {
      console.error("Worker error:", e);
    };
    client = Rpc.client<typeof rpc>(worker);
  }
  if (!client) {
    throw new Error("Auth client not initialized");
  }
  return client;
}

export async function terminateAuthClient() {
  if (worker && client) {
    await client.call("stopServer", undefined);
    worker.terminate();
    worker = undefined;
    client = undefined;
  }
}

export async function startLogin() {
  const c = getAuthClient();
  const { url } = await c.call("startLogin", undefined);
  globalThis.Bun.spawn(["open", url]);
  return {
    onSuccess: (handler: () => void) => c.on("login.success", handler),
    onError: (handler: (e: { error: string }) => void) =>
      c.on("login.error", handler),
  };
}

export async function cancelLogin() {
  const c = getAuthClient();
  await c.call("cancelLogin", undefined);
}
