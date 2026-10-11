import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const isAddressInfo = (
  address: string | AddressInfo | null
): address is AddressInfo => address !== null && typeof address === "object";

const server = createServer((request, response) => {
  response.end(request.headers.host);
});

afterAll(() => server.close());

describe("local app hostname", () => {
  test("a deployment subdomain resolves to a loopback-only listener without a custom Host header", async () => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!isAddressInfo(address)) {
      throw new Error("Expected a loopback port");
    }
    const host = `devver-probe.localhost:${address.port}`;
    const response = await fetch(`http://${host}/`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(host);
  });
});
