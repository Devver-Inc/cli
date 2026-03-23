import { Effect } from "effect";
import { getAuthClient, startLogin, terminateAuthClient, getOrganizationDetails, refreshAccessToken } from "../auth/client";
import { cmd } from "./cmd";
import { Prompt } from "../util/prompts";
import { getCurrentOrganization, setCurrentOrganization } from "../auth/organization";


const SelectOrganizationCommand = cmd({
  command: "list",
  describe: "list all orgs and select one",
  async handler() {
    const organizations = await getOrganizationDetails();
    const currentOrg = await getCurrentOrganization();

    if (organizations.length === 0) {
      console.log("✗ Not part of any organization");
      return;
    }

    if (organizations.length === 1) {
      console.log("You only have one organization:", organizations[0]?.name ?? 'Unknown');
      return;
    }

    const choice = await Effect.runPromise(
      Effect.gen(function* () {
        const currentOrgData = organizations.find(org => org.id === currentOrg) ?? organizations[0];
        yield* Prompt.intro(`Current organization: ${currentOrgData?.name ?? 'Unknown'}`);

        const choice = yield* Prompt.select({
          message: "Select an organization to change:",
          options: organizations.map(org => ({
            value: org.id,
            label: org.id === currentOrgData?.id ? `${org.name} (current)` : org.name,
          })),
        });

        if (choice === "Canceled") {
          yield* Prompt.outro("Organization selection canceled");
          return null;
        }

        const spinner = Prompt.spinner();
        yield* spinner.start("Switching organization...");

        const selectedOrg = organizations.find(org => org.id === choice);

        yield* spinner.stop("Organization switched successfully");
        yield* Prompt.outro(`Now using organization: ${selectedOrg?.name ?? choice}`);
        return choice;
      })

    );

    if (choice) {
      await setCurrentOrganization(choice as string);
      
      // Request a fresh access token for the newly selected organization
      // This ensures the token is cached for future API calls
      try {
        await refreshAccessToken();
      } catch (error) {
        console.error("Warning: Failed to fetch access token for organization:", error);
      }
    }

    process.exit(0);
  },
});

export const OrganizationCommand = cmd({
  command: "org",
  describe: "manage organizations",
  builder: (yargs) =>
    yargs
      .command(SelectOrganizationCommand)
      .demandCommand(),
  async handler() {
    await new Promise(() => ({}));
  },
});
