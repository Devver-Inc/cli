import { Console, Data, Effect } from "effect";
import { Command } from "effect/cli";

import { getOrganizationDetails, refreshAccessToken } from "../auth/client";
import {
  clearCurrentOrganization,
  getCurrentOrganization,
  setCurrentOrganization,
} from "../auth/organization";
import { Prompt } from "../util/prompts";

class OrganizationSwitchError extends Data.TaggedError(
  "OrganizationSwitchError"
)<{ message: string }> {}

export const switchOrganization = (
  current: string | null,
  choice: string,
  refresh: () => Promise<string | null> = refreshAccessToken
) =>
  Effect.tryPromise(async () => setCurrentOrganization(choice)).pipe(
    Effect.flatMap(() =>
      Effect.tryPromise(refresh).pipe(
        Effect.flatMap((token) =>
          token !== null && token !== ""
            ? Effect.void
            : Effect.fail(
                new OrganizationSwitchError({
                  message: "Failed to refresh organization credentials",
                })
              )
        ),
        Effect.tapError(() =>
          Effect.tryPromise(async () =>
            current !== null && current !== ""
              ? setCurrentOrganization(current)
              : clearCurrentOrganization()
          )
        )
      )
    )
  );

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const organizations = yield* Effect.tryPromise(getOrganizationDetails);
    const current = yield* Effect.tryPromise(getCurrentOrganization);
    if (organizations.length === 0) {
      yield* Console.log("✗ Not part of any organization");
      return;
    }
    if (organizations.length === 1) {
      yield* Console.log(
        "You only have one organization:",
        organizations[0]?.name ?? "Unknown"
      );
      return;
    }
    const selected =
      organizations.find((org) => org.id === current) ?? organizations[0];
    yield* Prompt.intro(`Current organization: ${selected?.name ?? "Unknown"}`);
    const choice = yield* Prompt.select({
      message: "Select an organization to change:",
      options: organizations.map((org) => ({
        value: org.id,
        label: org.id === selected?.id ? `${org.name} (current)` : org.name,
      })),
    });
    if (choice === "Canceled") {
      yield* Prompt.outro("Organization selection canceled");
      return;
    }
    yield* switchOrganization(current, choice);
    yield* Prompt.outro(
      `Now using organization: ${organizations.find((org) => org.id === choice)?.name ?? choice}`
    );
  })
);

export const organization = Command.make("org").pipe(
  Command.withDescription("Manage organizations"),
  Command.withSubcommands([list])
);
