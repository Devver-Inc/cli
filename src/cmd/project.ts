import { getProjectById, getProjects } from "../api/projects.requests";
import { disposeRuntime, runAuthenticated } from "../util/runtime";
import { cmd } from "./cmd";

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
  describe: "List projects",
  async handler() {
    const projects = await runAuthenticated(getProjects);
    for (const project of projects) {
      console.log(`${project.id}: ${project.name}`);
    }
    await disposeRuntime();
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
      .command(ProjectUseCommand)
      .command(ProjectListCommand)
      .command(ProjectInfoCommand)
      .command(ProjectLinkCommand)
      .demandCommand(),
  async handler() {
    await new Promise(() => ({}));
  },
});
