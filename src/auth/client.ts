import { Rpc } from "../util/rpc";
import { Storage } from "../storage";
import type { rpc } from "./worker";

const API_RESOURCE = "http://localhost:9999";
const TOKEN_EXPIRY_BUFFER_SECONDS = 60;

interface StoredTokenEntry {
  token: string;
  scope: string;
  expiresAt: number;
}

type StoredTokens = Record<string, StoredTokenEntry>;

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

async function getStoredToken(): Promise<string | null> {
  try {
    const exists = await Storage.fileExists("logto/accessToken");
    if (!exists) {
      return null;
    }

    const content = await Storage.readToString("logto/accessToken");
    const tokens: StoredTokens = JSON.parse(content);

    const idTokenContent = await Storage.readToString("logto/idToken");
    const idToken = JSON.parse(idTokenContent);
    const orgId = idToken?.claims?.organizations?.[0];

    const tokenKey = orgId ? `@${API_RESOURCE}#${orgId}` : `@${API_RESOURCE}`;
    const entry = tokens[tokenKey];

    if (!entry) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (entry.expiresAt > now + TOKEN_EXPIRY_BUFFER_SECONDS) {
      return entry.token;
    }

    return null;
  } catch {
    return null;
  }
}

async function refreshToken(): Promise<string | null> {
  const authClient = getAuthClient();
  const token = await authClient.call("getAccessToken", undefined);
  await terminateAuthClient();
  return token;
}

export async function getAccessToken(): Promise<string | null> {
  const storedToken = await getStoredToken();
  if (storedToken) {
    return storedToken;
  }
  return refreshToken();
}
