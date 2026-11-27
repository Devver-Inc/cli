import { join } from "node:path";

import { Context, Effect, Layer } from "effect";

import { startup } from "./deployment/failures";
import { instanceParent } from "./identity";

export interface InstanceDirectoryService {
  readonly directory: string;
  readonly worktrees: string;
  readonly repositories: string;
}

export const InstanceDirectory = Context.Service<InstanceDirectoryService>(
  "devver/server/InstanceDirectory"
);

export const instanceDirectoryLayer = (name: string) =>
  Layer.effect(
    InstanceDirectory,
    Effect.gen(function* () {
      const parent = yield* Effect.orDie(
        startup(async () => await instanceParent(name))
      );
      const directory = join(parent, name);
      return {
        directory,
        worktrees: join(directory, "worktrees"),
        repositories: join(directory, "repositories"),
      };
    })
  );
