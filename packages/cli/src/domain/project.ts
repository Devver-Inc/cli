import { Data, Effect, Schema } from "effect";

export const OverlayCommentPermission = {
  TEAM_ONLY: "team_only",
  EMAIL_REQUIRED: "email_required",
} as const;

export const DatabaseType = { MONGO: "mongo" } as const;

export const ProjectNameField = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isNonEmpty()
);

export const ProjectDescriptionField = Schema.NullishOr(
  Schema.NonEmptyString.check(Schema.isMaxLength(256))
);

export const MachineConfigurationBase = {
  cpuCores: Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 2 })),
  ram: Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 2 })),
};

export const OverlayAccessControlBase = {
  commentPermission: Schema.Literals([
    OverlayCommentPermission.TEAM_ONLY,
    OverlayCommentPermission.EMAIL_REQUIRED,
  ]),
};

export const CreateProjectSchema = Schema.Struct({
  name: ProjectNameField,
  description: Schema.optional(ProjectDescriptionField),
  machineConfiguration: Schema.Struct({
    cpuCores: Schema.optional(MachineConfigurationBase.cpuCores),
    ram: Schema.optional(MachineConfigurationBase.ram),
  }),
  teamMemberIds: Schema.Array(Schema.NonEmptyString),
  overlayAccessControl: Schema.Struct({
    commentPermission: OverlayAccessControlBase.commentPermission,
  }),
  databaseConfiguration: Schema.optional(
    Schema.Struct({
      type: Schema.Literal(DatabaseType.MONGO),
      rootUsername: Schema.String.check(Schema.isMinLength(1)),
      rootPassword: Schema.String.check(Schema.isMinLength(1)),
      replicaCount: Schema.Int.check(
        Schema.isBetween({ minimum: 1, maximum: 3 })
      ),
      ram: Schema.Number.check(
        Schema.isFinite(),
        Schema.isGreaterThanOrEqualTo(0.5)
      ),
      cpuCores: Schema.Number.check(
        Schema.isFinite(),
        Schema.isGreaterThanOrEqualTo(0.1)
      ),
      storage: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 500 })),
    })
  ),
});

export type CreateProjectDto = typeof CreateProjectSchema.Type;

export class InvalidProjectInput extends Data.TaggedError(
  "InvalidProjectInput"
)<{
  message: string;
}> {}

export const validateCreateProject = (input: CreateProjectDto) =>
  Schema.decodeUnknownEffect(CreateProjectSchema)(input).pipe(
    Effect.mapError(
      () =>
        new InvalidProjectInput({
          message:
            "Invalid project settings. Check the name and resource limits.",
        })
    )
  );
