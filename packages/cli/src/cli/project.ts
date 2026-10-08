import { Console, Data, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import {
  createProject,
  getProjectById,
  getProjects,
} from "../api/projects.requests";
import { DatabaseType, OverlayCommentPermission } from "../domain/project";
import {
  getCurrentProjectId,
  setCurrentProjectId,
} from "../util/project/storage";
import { Prompt } from "../util/prompts";
import { withApi } from "./api";

class ProjectCommandError extends Data.TaggedError("ProjectCommandError")<{
  message: string;
}> {}

const projectCreationCancelled = Effect.fail(
  new ProjectCommandError({ message: "Project creation cancelled." })
);

const status = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const id = yield* Effect.tryPromise(getCurrentProjectId);
    if (id === null || id === "") {
      yield* Console.log("✗ No project selected");
      yield* Console.log("Use 'devver project list' to select a project");
      return;
    }
    const project = yield* withApi(getProjectById(id));
    yield* Console.log(`✓ Current project:\n  ${project.name} (${project.id})`);
  })
);

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const projects = yield* withApi(getProjects);
    const current = yield* Effect.tryPromise(getCurrentProjectId);
    if (projects.length === 0) {
      yield* Console.log("✗ No projects found");
      return;
    }
    const only = projects.length === 1 ? projects[0] : undefined;
    if (only !== undefined) {
      yield* Console.log("You only have one project:", only.name);
      yield* Effect.tryPromise(async () => setCurrentProjectId(only.id));
      return;
    }
    const displayed =
      projects.find((project) => project.id === current) ?? projects[0];
    yield* Prompt.intro(`Current project: ${displayed?.name ?? "None"}`);
    const choice = yield* Prompt.select({
      message: "Select a project:",
      options: projects.map((project) => ({
        value: project.id,
        label:
          project.id === displayed?.id
            ? `${project.name} (current)`
            : project.name,
      })),
    });
    if (choice === "Canceled") {
      yield* Prompt.outro("Project selection canceled");
      return;
    }
    yield* Effect.tryPromise(async () => setCurrentProjectId(choice));
    yield* Prompt.outro(
      `Now using project: ${projects.find((project) => project.id === choice)?.name ?? choice}`
    );
  })
);

const info = Command.make(
  "info",
  {
    id: Argument.String("id").pipe(Argument.withSchema(Schema.NonEmptyString)),
  },
  ({ id }) =>
    withApi(getProjectById(id)).pipe(
      Effect.flatMap((project) => Console.log(`${project.id}: ${project.name}`))
    )
);

const defaultDb = {
  replicaCount: 1,
  ram: 0.5,
  cpuCores: 0.1,
  storage: 5,
} as const;

const databaseNumber = (input: string, fallback: number) =>
  input === "" ? fallback : Number(input);

const databaseConfiguration = Effect.gen(function* () {
  const wantDb = yield* Prompt.select({
    message: "Attach a database to this project?",
    options: Prompt.Questions.YNOpts,
  });
  if (wantDb === "Canceled") {
    return yield* projectCreationCancelled;
  }
  if (wantDb !== "Yes") {
    // An omitted database is a successful optional result, not cancellation.
    return undefined;
  }
  const rootUsername = yield* Prompt.input("Mongo root username");
  if (rootUsername === "Canceled") {
    return yield* projectCreationCancelled;
  }
  if (rootUsername === "") {
    return yield* new ProjectCommandError({
      message: "Mongo root username is required.",
    });
  }
  const rootPassword = yield* Prompt.secretInput("Mongo root password");
  if (rootPassword === "Canceled") {
    return yield* projectCreationCancelled;
  }
  if (rootPassword === "") {
    return yield* new ProjectCommandError({
      message: "Mongo root password is required.",
    });
  }
  const replicas = yield* Prompt.input(
    `Replicas (1-3) [${defaultDb.replicaCount}]`
  );
  if (replicas === "Canceled") {
    return yield* projectCreationCancelled;
  }
  const ramInput = yield* Prompt.input(`RAM (Gi, >=0.5) [${defaultDb.ram}]`);
  if (ramInput === "Canceled") {
    return yield* projectCreationCancelled;
  }
  const cpuInput = yield* Prompt.input(
    `CPU cores (>=0.1) [${defaultDb.cpuCores}]`
  );
  if (cpuInput === "Canceled") {
    return yield* projectCreationCancelled;
  }
  const storageInput = yield* Prompt.input(
    `Storage (Gi, 5-500) [${defaultDb.storage}]`
  );
  if (storageInput === "Canceled") {
    return yield* projectCreationCancelled;
  }
  return {
    type: DatabaseType.MONGO,
    rootUsername,
    rootPassword,
    replicaCount: databaseNumber(replicas, defaultDb.replicaCount),
    ram: databaseNumber(ramInput, defaultDb.ram),
    cpuCores: databaseNumber(cpuInput, defaultDb.cpuCores),
    storage: databaseNumber(storageInput, defaultDb.storage),
  };
});

const create = Command.make(
  "create",
  {
    name: Argument.String("name").pipe(
      Argument.withSchema(Schema.NonEmptyString)
    ),
    description: Flag.String("description").pipe(
      Flag.withAlias("d"),
      Flag.optional
    ),
    cpu: Flag.Finite("cpu").pipe(
      Flag.withSchema(
        Schema.Finite.check(Schema.isBetween({ minimum: 0.5, maximum: 2 }))
      ),
      Flag.withDefault(0.5)
    ),
    ram: Flag.Finite("ram").pipe(
      Flag.withSchema(
        Schema.Finite.check(Schema.isBetween({ minimum: 0.5, maximum: 2 }))
      ),
      Flag.withDefault(0.5)
    ),
    team: Flag.String("team").pipe(Flag.atLeast(0)),
    comments: Flag.Literals(
      "comments",
      Object.values(OverlayCommentPermission)
    ).pipe(Flag.withDefault(OverlayCommentPermission.TEAM_ONLY)),
    withDb: Flag.Boolean("with-db").pipe(Flag.withDefault(false)),
  },
  ({ name, description, cpu, ram, team, comments, withDb }) =>
    Effect.gen(function* () {
      const db = withDb ? yield* databaseConfiguration : undefined;
      const project = yield* withApi(
        createProject({
          name,
          machineConfiguration: { cpuCores: cpu, ram },
          teamMemberIds: [...team],
          overlayAccessControl: { commentPermission: comments },
          databaseConfiguration: db,
          description: Option.getOrUndefined(description),
        })
      );
      yield* Console.log(
        `Project created successfully!\n    Project ID: ${project.id}`
      );
      if (db !== undefined) {
        yield* Console.log(`    Database: ${db.type} (provisioning)`);
        yield* Console.log(
          "    Run 'devver deploy' to link it to a deployment."
        );
      }
      yield* Effect.tryPromise(async () => setCurrentProjectId(project.id));
    })
);

const link = Command.make(
  "link",
  {
    url: Argument.String("url"),
    name: Flag.String("name").pipe(Flag.withAlias("n"), Flag.optional),
    id: Flag.String("id").pipe(Flag.withAlias("i"), Flag.optional),
  },
  () =>
    Effect.fail(
      new ProjectCommandError({
        message: "devver project link is not supported yet",
      })
    )
);

export const project = Command.make("project").pipe(
  Command.withDescription("Manage projects"),
  Command.withSubcommands([status, list, info, create, link])
);
