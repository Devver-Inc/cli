import { Effect } from "effect";
import {
  createProject,
  DatabaseType,
  getProjectById,
  getProjects,
  OverlayCommentPermission,
} from "../api/projects.requests";
import { FormatError } from "../error";
import { UI } from "../ui";
import {
  getCurrentProjectId,
  setCurrentProjectId,
} from "../util/project/storage";
import { Prompt } from "../util/prompts";
import { disposeRuntime, runAuthenticated } from "../util/runtime";
import { cmd } from "./cmd";

type DatabaseConfigurationDto = NonNullable<
  Parameters<typeof createProject>[0]["databaseConfiguration"]
>;

const ProjectStatusCommand = cmd({
  command: "status",
  describe: "Show current project",
  async handler() {
    const currentProjectId = await getCurrentProjectId();

    if (!currentProjectId) {
      console.log("✗ No project selected");
      console.log("Use 'devver project list' to select a project");
      await disposeRuntime();
      return;
    }

    try {
      const project = await runAuthenticated(getProjectById(currentProjectId));
      console.log("✓ Current project:");
      console.log(`  ${project.name} (${project.id})`);
    } catch (error) {
      const msg = FormatError(error);
      UI.error(msg ?? "Failed to fetch project details");
      console.log(`  Project ID: ${currentProjectId}`);
    }

    await disposeRuntime();
  },
});

const ProjectListCommand = cmd({
  command: "list",
  describe: "List projects and select one",
  async handler() {
    const result = await runAuthenticated(getProjects).catch(
      (error: unknown) => {
        UI.error(FormatError(error) ?? "Failed to fetch projects");
        return null;
      }
    );
    if (!result) {
      await disposeRuntime();
      return;
    }
    const projects = result;
    const currentProjectId = await getCurrentProjectId();

    if (projects.length === 0) {
      console.log("✗ No projects found");
      await disposeRuntime();
      return;
    }

    if (projects.length === 1 && projects[0]) {
      console.log("You only have one project:", projects[0].name);
      await setCurrentProjectId(projects[0].id);
      await disposeRuntime();
      return;
    }

    const choice = await Effect.runPromise(
      Effect.gen(function* () {
        const currentProject = projects.find((p) => p.id === currentProjectId);
        const displayProject = currentProject ?? projects[0];
        yield* Prompt.intro(
          `Current project: ${displayProject?.name ?? "None"}`
        );

        const choice = yield* Prompt.select({
          message: "Select a project:",
          options: projects.map((project) => ({
            value: project.id,
            label:
              displayProject && project.id === displayProject.id
                ? `${project.name} (current)`
                : project.name,
          })),
        });

        if (choice === "Canceled") {
          yield* Prompt.outro("Project selection canceled");
          return null;
        }

        const spinner = Prompt.spinner();
        yield* spinner.start("Switching project...");

        const selectedProject = projects.find((p) => p.id === choice);

        yield* spinner.stop("Project switched successfully");
        yield* Prompt.outro(
          `Now using project: ${selectedProject?.name ?? choice}`
        );
        return choice;
      })
    );

    if (choice) {
      await setCurrentProjectId(choice as string);
    }

    await disposeRuntime();
    process.exit(0);
  },
});

const ProjectInfoCommand = cmd({
  command: "info <id>",
  describe: "Show project details",
  builder: (yargs) =>
    yargs.positional("id", {
      type: "string",
      demandOption: true,
      describe: "Project id",
    }),
  async handler(args) {
    try {
      const project = await runAuthenticated(getProjectById(args.id));
      console.log(`${project.id}: ${project.name}`);
    } catch (error) {
      UI.error(FormatError(error) ?? "Failed to fetch project");
    }
    await disposeRuntime();
  },
});

// Default cluster limits enforced by the backend (see DatabaseConfigurationDto).
const DEFAULT_DB = {
  replicaCount: 1,
  ram: 0.5,
  cpuCores: 0.1,
  storage: 5,
} as const;

async function promptDatabaseConfiguration(): Promise<
  DatabaseConfigurationDto | undefined
> {
  const wantDb = await Prompt.promptYesNo("Attach a database to this project?");
  if (!wantDb) {
    return undefined;
  }

  // For now the backend only supports Mongo.
  const type = DatabaseType.MONGO;

  const rootUsername = await Effect.runPromise(
    Prompt.input("Mongo root username")
  );
  if (!rootUsername || rootUsername === "Canceled") {
    return undefined;
  }

  const rootPassword = await Effect.runPromise(
    Prompt.input("Mongo root password")
  );
  if (!rootPassword || rootPassword === "Canceled") {
    return undefined;
  }

  const replicaCountStr = await Effect.runPromise(
    Prompt.input(`Replicas (1-3) [${DEFAULT_DB.replicaCount}]`)
  );
  const replicaCount = Number(replicaCountStr) || DEFAULT_DB.replicaCount;

  const ramStr = await Effect.runPromise(
    Prompt.input(`RAM (Gi, >=0.5) [${DEFAULT_DB.ram}]`)
  );
  const ram = Number(ramStr) || DEFAULT_DB.ram;

  const cpuCoresStr = await Effect.runPromise(
    Prompt.input(`CPU cores (>=0.1) [${DEFAULT_DB.cpuCores}]`)
  );
  const cpuCores = Number(cpuCoresStr) || DEFAULT_DB.cpuCores;

  const storageStr = await Effect.runPromise(
    Prompt.input(`Storage (Gi, 5-500) [${DEFAULT_DB.storage}]`)
  );
  const storage = Number(storageStr) || DEFAULT_DB.storage;

  return {
    type,
    rootUsername,
    rootPassword,
    replicaCount,
    ram,
    cpuCores,
    storage,
  };
}

const ProjectCreateCommand = cmd({
  command: "create <name>",
  describe: "Create a new project (with optional database)",
  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        demandOption: true,
        describe: "Project name",
      })
      .option("description", {
        alias: "d",
        type: "string",
        describe: "Project description",
      })
      .option("cpu", {
        type: "number",
        describe: "Machine CPU cores (0.5-2)",
      })
      .option("ram", {
        type: "number",
        describe: "Machine RAM in Gi (0.5-2)",
      })
      .option("team", {
        type: "array",
        string: true,
        describe: "Team member user ids",
        default: [] as string[],
      })
      .option("comments", {
        type: "string",
        choices: Object.values(OverlayCommentPermission) as string[],
        default: OverlayCommentPermission.TEAM_ONLY,
        describe: "Overlay comment permission",
      })
      .option("with-db", {
        type: "boolean",
        default: false,
        describe: "Interactively attach a Mongo database during creation",
      }),
  async handler(args) {
    try {
      const cpuCores = args.cpu ?? 0.5;
      const ram = args.ram ?? 0.5;

      let databaseConfiguration: DatabaseConfigurationDto | undefined;
      if (args.withDb) {
        databaseConfiguration = await promptDatabaseConfiguration();
      }

      // Build the create payload. Only include `description` when actually
      // provided: the backend's @Optional() (class-validator-extended) skips
      // validation only for `undefined`, NOT `null`, so sending `null` trips
      // @IsString/@MaxLength. Omit the key entirely when absent.
      const payload: Parameters<typeof createProject>[0] = {
        name: args.name,
        machineConfiguration: { cpuCores, ram },
        teamMemberIds: args.team ?? [],
        overlayAccessControl: {
          commentPermission:
            args.comments as (typeof OverlayCommentPermission)[keyof typeof OverlayCommentPermission],
        },
        databaseConfiguration,
        ...(args.description ? { description: args.description } : {}),
      };

      const spinner = Prompt.spinner();
      await Effect.runPromise(spinner.start("Creating project..."));

      const startTime = performance.now();
      const project = await runAuthenticated(createProject(payload));
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

      await Effect.runPromise(
        spinner.stop(`Project created successfully! (${elapsed}s)`)
      );
      console.log(`    Project ID: ${project.id}`);
      if (databaseConfiguration) {
        console.log(
          `    Database: ${databaseConfiguration.type} (provisioning)`
        );
        console.log("    Run 'devver deploy' to link it to a deployment.");
      }

      await setCurrentProjectId(project.id);
    } catch (e) {
      if (process.env.DEVVER_DEBUG) {
        console.error("[devver] raw create error:", e);
      }
      const msg = FormatError(e);
      UI.error(msg ?? `Project creation failed: ${String(e)}`);
    } finally {
      await disposeRuntime();
      process.exit(0);
    }
  },
});

const ProjectLinkCommand = cmd({
  command: "link <url>",
  describe: "Link external repo (use --name for new, --id to update)",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        demandOption: true,
        describe: "Repository URL",
      })
      .option("name", {
        alias: "n",
        type: "string",
        describe: "Create new project with this name",
      })
      .option("id", {
        alias: "i",
        type: "string",
        describe: "Update existing project by ID",
      })
      .example(
        "$0 project link https://github.com/foo/bar --name myproject",
        "Link new repo"
      )
      .example(
        "$0 project link https://github.com/foo/new --id abc123",
        "Update existing"
      )
      .check((args) => {
        if (args.name && args.id) {
          throw new Error("Use --name OR --id, not both");
        }
        if (!(args.name || args.id)) {
          throw new Error("Provide --name (new) or --id (existing)");
        }
        return true;
      }),
  async handler(args) {
    if (args.name) {
      console.log("Creating:", args.name, args.url);
    } else {
      console.log("Updating:", args.id, args.url);
    }
    await new Promise(() => ({}));
  },
});

export const ProjectCommand = cmd({
  command: "project",
  describe: "manage projects",
  builder: (yargs) =>
    yargs
      .command(ProjectStatusCommand)
      .command(ProjectListCommand)
      .command(ProjectInfoCommand)
      .command(ProjectCreateCommand)
      .command(ProjectLinkCommand)
      .demandCommand(),
  async handler() {
    await new Promise(() => ({}));
  },
});
