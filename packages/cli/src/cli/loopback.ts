import type { AddressInfo } from "node:net";
import { createServer } from "node:net";

/** A bound TCP socket, as opposed to a pipe name or an unbound server. */
const isTcpAddress = (
  address: ReturnType<ReturnType<typeof createServer>["address"]>
): address is AddressInfo => address !== null && typeof address !== "string";

export async function availablePort() {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!isTcpAddress(address)) {
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
