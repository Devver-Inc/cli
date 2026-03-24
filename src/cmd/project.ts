import { Effect } from "effect";
import { getProjectById, getProjects } from "../api/projects.requests";
import { getCurrentProject, setCurrentProject } from "../project/storage";
import { Prompt } from "../util/prompts";
import { disposeRuntime, runAuthenticated } from "../util/runtime";
import { cmd } from "./cmd";

const ProjectStatusCommand = cmd({
  command: "status",
  describe: "Show current project",
  async handler() {
    const currentProjectId = await getCurrentProject();

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
      console.error("✗ Failed to fetch project details:", error);
      console.log(`  Project ID: ${currentProjectId}`);
    }

    await disposeRuntime();
  },
});

const ProjectUseCommand = cmd({
  command: "use <id>",
  describe: "Select active project",
  builder: (yargs) =>
    yargs.positional("id", {
      type: "string",
      demandOption: true,
      describe: "Project id",
    }),
  async handler(args) {
    console.log("Using project ", args.id);
    await new Promise(() => ({}));
  },
});

const ProjectListCommand = cmd({
  command: "list",
  describe: "List projects and select one",
  async handler() {
    const projects = await runAuthenticated(getProjects);
    const currentProjectId = await getCurrentProject();

    if (projects.length === 0) {
      console.log("✗ No projects found");
      await disposeRuntime();
      return;
    }

    if (projects.length === 1 && projects[0]) {
      console.log("You only have one project:", projects[0].name);
      await setCurrentProject(projects[0].id);
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
      await setCurrentProject(choice as string);
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
    const project = await runAuthenticated(getProjectById(args.id));
    console.log(`${project.id}: ${project.name}`);
    await disposeRuntime();
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
      .command(ProjectUseCommand)
      .command(ProjectListCommand)
      .command(ProjectInfoCommand)
      .command(ProjectLinkCommand)
      .demandCommand(),
  async handler() {
    await new Promise(() => ({}));
  },
});
