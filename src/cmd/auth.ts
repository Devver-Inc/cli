import { getAuthClient, startLogin, terminateAuthClient, getOrganizationDetails } from "../auth/client";
import { getCurrentOrganization, setCurrentOrganization } from "../auth/organization";
import { getCurrentProject } from "../project/storage";
import { getProjectById } from "../api/projects.requests";
import { runAuthenticated, disposeRuntime } from "../util/runtime";
import { cmd } from "./cmd";

const AuthLoginCommand = cmd({
  command: "login",
  describe: "authenticate to your devver server",
  async handler() {
    console.log("Opening browser for login...");

    const { onSuccess, onError } = await startLogin();

    await new Promise<void>((resolve, reject) => {
      onSuccess(() => {
        console.log("✓ Login successful!");
        resolve();
      });
      onError((e) => {
        console.error("✗ Login failed:", e.error);
        reject(new Error(e.error));
      });
    });

    await terminateAuthClient();
  },
});

const AuthLogoutCommand = cmd({
  command: "logout",
  describe: "logout from your devver server",
  async handler() {
    const client = getAuthClient();
    await client.call("logout", undefined);
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
          const currentOrgData = organizations.find(o => o.id === currentOrg);
          if (currentOrg && currentOrgData) {
            console.log(`\nCurrent organization: ${currentOrgData.name}`);
          } else {
            console.log(`\nCurrent organization: ${organizations[0]?.name ?? 'Unknown'} (default)`);
          }
        } else {
          console.log("✗ Not part of any organization");
        }

        // Show current project if one is selected
        const currentProjectId = await getCurrentProject();
        if (currentProjectId) {
          try {
            const project = await runAuthenticated(getProjectById(currentProjectId));
            console.log(`\nCurrent project: ${project.name}`);
          } catch (error) {
            console.log(`\nCurrent project: ${currentProjectId} (details unavailable)`);
          }
        }
      } catch (error) {
        console.error("✗ Failed to fetch organization details:", error);
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
