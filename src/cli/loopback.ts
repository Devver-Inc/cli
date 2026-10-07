/**
 * Loopback port allocation shared by every platform's supervisor.
 *
 * Binding port 0 on 127.0.0.1 lets the OS pick a free port and proves the
 * address is bindable before a supervised server is registered for it. Nothing
 * here is platform specific, so all three supervisors use this one copy.
 */

import { createServer } from "node:net";

export async function availablePort() {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not allocate a loopback port");
    }
    return address.port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
