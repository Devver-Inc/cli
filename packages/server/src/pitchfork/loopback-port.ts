import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

function isTcpAddress(
  address: string | AddressInfo | null
): address is AddressInfo {
  return address !== null && typeof address !== "string";
}

export async function allocatePort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  try {
    if (!isTcpAddress(address)) {
      throw new Error("Could not allocate a loopback port");
    }
    return address.port;
  } finally {
    await new Promise<void>((resolve) => {
      probe.close(() => {
        resolve();
      });
    });
  }
}
