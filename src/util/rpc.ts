/**
 * Minimal JSON-based RPC over Bun Workers.
 *
 * Worker side: Rpc.listen(handlers) to expose methods.
 * Main thread: Rpc.client<typeof handlers>(worker) to call them.
 * Also supports fire-and-forget events from worker -> main via Rpc.emit().
 *
 * Used to isolate the Logto auth client in a separate thread so its
 * local HTTP callback server doesn't block the main CLI event loop.
 */
declare const self: Worker;

interface Definition {
  [method: string]: (input: unknown) => unknown;
}

export function listen(rpc: Definition) {
  self.addEventListener("message", async (evt) => {
    const parsed = JSON.parse(evt.data);
    if (parsed.type === "rpc.request") {
      const fn = rpc[parsed.method];
      if (!fn) {
        postMessage(
          JSON.stringify({
            type: "rpc.result",
            result: null,
            id: parsed.id,
          })
        );
        return;
      }
      try {
        const result = await fn(parsed.input);
        postMessage(
          JSON.stringify({
            type: "rpc.result",
            result,
            id: parsed.id,
          })
        );
      } catch (err) {
        postMessage(
          JSON.stringify({
            type: "rpc.result",
            result: null,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            id: parsed.id,
          })
        );
      }
    }
  });
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }));
}

export function client<T extends Definition>(target: Worker) {
  const pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  let id = 0;
  target.addEventListener("message", (evt) => {
    let parsed;
    try {
      parsed = JSON.parse(evt.data);
    } catch {
      console.error("[RPC] Non-JSON message from worker:", evt.data);
      return;
    }
    if (parsed.type === "rpc.result") {
      const entry = pending.get(parsed.id);
      if (entry) {
        if (parsed.error) {
          const err = new Error(parsed.error);
          if (parsed.stack) {
            err.stack = parsed.stack;
          }
          entry.reject(err);
        } else {
          entry.resolve(parsed.result);
        }
        pending.delete(parsed.id);
      }
    }
    if (parsed.type === "rpc.event") {
      const handlers = listeners.get(parsed.event);
      if (handlers) {
        for (const handler of handlers) {
          handler(parsed.data);
        }
      }
    }
  });
  return {
    call<Method extends keyof T>(
      method: Method,
      input: Parameters<T[Method]>[0]
    ): Promise<ReturnType<T[Method]>> {
      const requestId = id++;
      return new Promise((resolve, reject) => {
        pending.set(requestId, {
          resolve: resolve as (result: unknown) => void,
          reject,
        });
        target.postMessage(
          JSON.stringify({
            type: "rpc.request",
            method,
            input,
            id: requestId,
          })
        );
      });
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      let handlers = listeners.get(event);
      if (!handlers) {
        handlers = new Set();
        listeners.set(event, handlers);
      }
      handlers.add(handler as (data: unknown) => void);
      return () => {
        handlers.delete(handler as (data: unknown) => void);
      };
    },
  };
}

export const Rpc = {
  listen,
  emit,
  client,
};
