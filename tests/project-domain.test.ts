import { expect, test } from "bun:test";

import { Effect } from "effect";

import {
  DatabaseType,
  OverlayCommentPermission,
  validateCreateProject,
} from "../packages/cli/src/domain/project";

const settings = {
  name: "demo",
  machineConfiguration: { cpuCores: 0.5, ram: 0.5 },
  teamMemberIds: [],
  overlayAccessControl: {
    commentPermission: OverlayCommentPermission.TEAM_ONLY,
  },
};

test("project settings omit absent descriptions and reject invalid database resources without exposing passwords", async () => {
  const valid = await Effect.runPromise(
    validateCreateProject({ ...settings, description: undefined })
  );
  expect(JSON.stringify(valid)).not.toContain('"description"');

  const rejected = await Effect.runPromise(
    Effect.flip(
      validateCreateProject({
        ...settings,
        databaseConfiguration: {
          type: DatabaseType.MONGO,
          rootUsername: "admin",
          rootPassword: "private-password",
          replicaCount: 1,
          ram: Number.POSITIVE_INFINITY,
          cpuCores: 0.1,
          storage: 5,
        },
      })
    )
  );
  expect(rejected._tag).toBe("InvalidProjectInput");
  expect(JSON.stringify(rejected)).not.toContain("private-password");
});
