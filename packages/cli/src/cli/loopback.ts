import { createServer } from "node:net";

export async function availablePort() {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    // node:net returns an AddressInfo, a pipe name, or null.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    if (address === null || typeof address === "string") {
      throw new Error("Could not allocate a loopback port");
    }
    return address.port;
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}
