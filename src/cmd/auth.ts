import { getProjectById } from "../api/projects.requests";
import {
  getAccessToken,
  getAuthClient,
  getOrganizationDetails,
  startLogin,
  terminateAuthClient,
} from "../auth/client";
import { getCurrentOrganization } from "../auth/organization";
import { FormatError } from "../error";
import { UI } from "../ui";
import { getCurrentProjectId } from "../util/project/storage";
import { getLinkedRepoForCwd } from "../util/repository/storage";
import { disposeRuntime, runAuthenticated } from "../util/runtime";
import { cmd } from "./cmd";

const AuthLoginCommand = cmd({
  command: "login",
  describe: "authenticate to your devver server",
  async handler() {
    console.log("Opening browser for login...");

    try {
      const { onSuccess, onError } = await startLogin();

      await new Promise<void>((resolve, reject) => {
        onSuccess(() => {
          console.log("✓ Login successful!");
          resolve();
        });
        onError((e) => {
          const msg = FormatError(new Error(e.error)) ?? e.error;
          UI.error(`Login failed: ${msg}`);
          reject(new Error(msg));
        });
      });

      await terminateAuthClient();
    } catch (e) {
      const msg = FormatError(e) ?? String(e);
      UI.error(`Login failed: ${msg}`);
      await terminateAuthClient();
    }
  },
});

const AuthLogoutCommand = cmd({
  command: "logout",
  describe: "logout from your devver server",
  async handler() {
    const client = getAuthClient();
    const result = (await client.call("logout", undefined)) as {
      url?: string;
    };

    if (result?.url) {
      console.log("Opening browser to complete logout...");
      await Bun.spawn(["open", result.url]);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    console.log("✓ Logged out");
    await terminateAuthClient();
  },
});

const AuthStatusCommand = cmd({
  command: "status",
  describe: "Show login status",
  async handler() {
    const client = getAuthClient();
    const user = await client.call("getUser", undefined);
    if (user) {
      console.log("✓ Logged in as:", user.username ?? user.sub);

      try {
        const organizations = await getOrganizationDetails();
        const currentOrg = await getCurrentOrganization();

        if (organizations.length > 0) {
          console.log("\nOrganizations:");
          for (const org of organizations) {
            const marker = org.id === currentOrg ? "* " : "  ";
            console.log(`${marker}${org.name}`);
          }
          const currentOrgData = organizations.find((o) => o.id === currentOrg);
          if (currentOrg && currentOrgData) {
            console.log(`\nCurrent organization: ${currentOrgData.name}`);
          } else {
            console.log(
              `\nCurrent organization: ${organizations[0]?.name ?? "Unknown"} (default)`
            );
          }
        } else {
          console.log("✗ Not part of any organization");
        }
        const currentProjectId = await getCurrentProjectId();
        if (currentProjectId) {
          try {
            const project = await runAuthenticated(
              getProjectById(currentProjectId)
            );
            console.log(`\nCurrent project: ${project.name}`);
          } catch (error) {
            const msg = FormatError(error);
            console.log(
              `\nCurrent project: ${currentProjectId} (${msg ?? "details unavailable"})`
            );
          }
        }
        const linked = await getLinkedRepoForCwd();
        console.log(
          `\nCurrent repository: ${linked ? linked.repoName : "No repository linked to this folder"} `
        );
        const accessToken = await getAccessToken();
        console.log(accessToken);
      } catch (error) {
        UI.error(
          `Failed to fetch organization details: ${FormatError(error) ?? String(error)}`
        );
      }
    } else {
      console.log("✗ Not logged in");
    }
    await terminateAuthClient();
    await disposeRuntime();
  },
});

export const AuthCommand = cmd({
  command: "auth",
  describe: "manage authentication",
  builder: (yargs) =>
    yargs
      .command(AuthLoginCommand)
      .command(AuthLogoutCommand)
      .command(AuthStatusCommand)
      .demandCommand(),
  async handler() {
    await new Promise(() => ({}));
  },
});
