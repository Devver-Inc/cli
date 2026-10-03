import { Effect, Schema } from "effect";
import { ApiClient, type ApiRequestError } from "./client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OverlayCommentPermission = {
  TEAM_ONLY: "team_only",
  EMAIL_REQUIRED: "email_required",
} as const;

export type OverlayCommentPermission =
  (typeof OverlayCommentPermission)[keyof typeof OverlayCommentPermission];

export const DatabaseType = {
  MONGO: "mongo",
} as const;

export type DatabaseType = (typeof DatabaseType)[keyof typeof DatabaseType];

// ---------------------------------------------------------------------------
// Schemas -- *Base objects are shared between input and response schemas
// to avoid duplication while keeping validation constraints separate.
// ---------------------------------------------------------------------------

const GetUserLightSchema = Schema.Struct({
  id: Schema.String,
  email: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});

const MachineConfigurationBase = {
  cpuCores: Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 2 })),
  ram: Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 2 })),
};

const OverlayAccessControlBase = {
  commentPermission: Schema.Literals([
    OverlayCommentPermission.TEAM_ONLY,
    OverlayCommentPermission.EMAIL_REQUIRED,
  ]),
};

const MachineConfigurationResponse = Schema.Struct(MachineConfigurationBase);
const OverlayAccessControlResponse = Schema.Struct(OverlayAccessControlBase);

const MachineConfigurationInput = Schema.Struct({
  cpuCores: Schema.optional(MachineConfigurationBase.cpuCores),
  ram: Schema.optional(MachineConfigurationBase.ram),
});

const OverlayAccessControlInput = Schema.Struct({
  commentPermission: OverlayAccessControlBase.commentPermission,
});

// -- Database configuration ------------------------------------------------

const DatabaseConfigurationInput = Schema.Struct({
  type: Schema.Literal(DatabaseType.MONGO),
  rootUsername: Schema.String.check(Schema.isMinLength(1)),
  rootPassword: Schema.String.check(Schema.isMinLength(1)),
  replicaCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  ram: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0.5)),
  cpuCores: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0.1)),
  storage: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 500 })),
});

export const DatabaseConfigurationResponseSchema = Schema.Struct({
  type: Schema.Literal(DatabaseType.MONGO),
  enabled: Schema.Boolean,
  rootUsername: Schema.optional(Schema.String),
  hasRootPassword: Schema.optional(Schema.Boolean),
  replicaCount: Schema.optional(Schema.Number),
  ram: Schema.optional(Schema.Number),
  cpuCores: Schema.optional(Schema.Number),
  storage: Schema.optional(Schema.Number),
});

// -- Project ---------------------------------------------------------------

const ProjectNameField = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isNonEmpty()
);

const ProjectDescriptionField = Schema.NullishOr(
  Schema.NonEmptyString.check(Schema.isMaxLength(256))
);

const ProjectBase = {
  name: ProjectNameField,
  description: ProjectDescriptionField,
};

export const CreateProjectSchema = Schema.Struct({
  name: ProjectNameField,
  description: Schema.optional(ProjectDescriptionField),
  machineConfiguration: MachineConfigurationInput,
  teamMemberIds: Schema.Array(Schema.NonEmptyString),
  overlayAccessControl: OverlayAccessControlInput,
  databaseConfiguration: Schema.optional(DatabaseConfigurationInput),
});

export const CreateProjectResponseSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  ...ProjectBase,
  createdAt: Schema.DateFromString,
});

type CreateProjectResponse = Schema.Schema.Type<
  typeof CreateProjectResponseSchema
>;

export const GetProjectSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  ...ProjectBase,
  organizationId: Schema.NonEmptyString,
  createdBy: Schema.NullOr(GetUserLightSchema),
  machineConfiguration: MachineConfigurationResponse,
  teamMembers: Schema.Array(GetUserLightSchema),
  overlayAccessControl: OverlayAccessControlResponse,
  databaseConfiguration: Schema.NullishOr(DatabaseConfigurationResponseSchema),
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
});

export const GetProjectListItemSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullishOr(Schema.String),
  createdAt: Schema.DateFromString,
});

export const GetProjectsSchema = Schema.Array(GetProjectSchema);

export const PaginatedProjectsSchema = Schema.Struct({
  data: Schema.Array(GetProjectListItemSchema),
  meta: Schema.Struct({
    currentPage: Schema.Number,
    totalItemsCount: Schema.Number,
    totalPagesCount: Schema.Number,
    itemsPerPage: Schema.Number,
  }),
});

type CreateProjectDto = Schema.Schema.Type<typeof CreateProjectSchema>;

// ---------------------------------------------------------------------------
// Request functions
// ---------------------------------------------------------------------------

export const getProjects = Effect.gen(function* () {
  const api = yield* ApiClient;
  const response = yield* api.get("/projects", PaginatedProjectsSchema);
  return response.data;
});

export const getProjectById = (id: string) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.get(`/projects/${id}`, GetProjectSchema);
  });

export const createProject = (
  dto: CreateProjectDto
): Effect.Effect<CreateProjectResponse, ApiRequestError, ApiClient> =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.post("/projects", dto, CreateProjectResponseSchema);
  });

export const deleteProjectById = (id: string) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.delete(`/projects/${id}`, Schema.Void);
  });
