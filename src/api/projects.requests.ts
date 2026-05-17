import { Effect, Schema } from "effect";
import { ApiClient } from "./client";

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

export type DatabaseType =
  (typeof DatabaseType)[keyof typeof DatabaseType];

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
  cpuCores: Schema.Number.pipe(Schema.between(0.5, 2)),
  ram: Schema.Number.pipe(Schema.between(0.5, 2)),
};

const OverlayAccessControlBase = {
  commentPermission: Schema.Literal(
    OverlayCommentPermission.TEAM_ONLY,
    OverlayCommentPermission.EMAIL_REQUIRED
  ),
};

const MachineConfigurationResponse = Schema.Struct(MachineConfigurationBase);
const OverlayAccessControlResponse = Schema.Struct(OverlayAccessControlBase);

const MachineConfigurationInput = Schema.Struct({
  cpuCores: Schema.optionalWith(MachineConfigurationBase.cpuCores, {}),
  ram: Schema.optionalWith(MachineConfigurationBase.ram, {}),
});

const OverlayAccessControlInput = Schema.Struct({
  commentPermission: OverlayAccessControlBase.commentPermission,
});

// -- Database configuration ------------------------------------------------

const DatabaseConfigurationInput = Schema.Struct({
  type: Schema.Literal(...Object.values(DatabaseType)),
  rootUsername: Schema.String.pipe(Schema.minLength(1)),
  rootPassword: Schema.String.pipe(Schema.minLength(1)),
  replicaCount: Schema.Int.pipe(Schema.between(1, 3)),
  ram: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0.5)),
  cpuCores: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0.1)),
  storage: Schema.Int.pipe(Schema.between(5, 500)),
});

export const DatabaseConfigurationResponseSchema = Schema.Struct({
  type: Schema.Literal(...Object.values(DatabaseType)),
  enabled: Schema.Boolean,
  rootUsername: Schema.optional(Schema.String),
  hasRootPassword: Schema.optional(Schema.Boolean),
  replicaCount: Schema.optional(Schema.Number),
  ram: Schema.optional(Schema.Number),
  cpuCores: Schema.optional(Schema.Number),
  storage: Schema.optional(Schema.Number),
});

// -- Project ---------------------------------------------------------------

const ProjectBase = {
  name: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(128),
    Schema.nonEmptyString()
  ),
  description: Schema.NullishOr(
    Schema.NonEmptyString.pipe(Schema.maxLength(256))
  ),
};

export const CreateProjectSchema = Schema.Struct({
  ...ProjectBase,
  machineConfiguration: MachineConfigurationInput,
  teamMemberIds: Schema.Array(Schema.NonEmptyString),
  overlayAccessControl: OverlayAccessControlInput,
  databaseConfiguration: Schema.optional(DatabaseConfigurationInput),
});

export const GetProjectSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  ...ProjectBase,
  organizationId: Schema.NonEmptyString,
  createdBy: Schema.NullOr(GetUserLightSchema),
  machineConfiguration: MachineConfigurationResponse,
  teamMembers: Schema.Array(GetUserLightSchema),
  overlayAccessControl: OverlayAccessControlResponse,
  databaseConfiguration: Schema.NullOr(DatabaseConfigurationResponseSchema),
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

export const createProject = (dto: CreateProjectDto) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.post("/projects", dto, CreateProjectSchema);
  });

export const deleteProjectById = (id: string) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.delete(`/projects/${id}`, Schema.Void);
  });
