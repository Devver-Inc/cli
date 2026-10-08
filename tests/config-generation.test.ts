import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readConfigFile,
  writeConfigFile,
} from "../packages/cli/src/config/index";

const detected = (name: string) => ({
  detected: { name, displayName: name, detect: async () => true },
  confidence: "high" as const,
});

test("generated config omits absent database and service dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "devver-config-"));
  try {
    writeConfigFile({ results: [detected("react")], detectors: [] }, root);
    const config = readConfigFile(root);
    expect(config?.services.web?.depends).toBeUndefined();
    expect(config?.databases).toBeUndefined();
    expect(readFileSync(join(root, ".devver.yaml"), "utf-8")).not.toContain(
      "null"
    );

    writeConfigFile(
      { results: [detected("nestjs"), detected("mongoose")], detectors: [] },
      root
    );
    const databaseConfig = readConfigFile(root);
    expect(databaseConfig?.services.api?.depends).toEqual(["mongodb"]);
    expect(databaseConfig?.databases).toEqual({ mongodb: { type: "mongodb" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
