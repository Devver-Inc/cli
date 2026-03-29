import { Effect, Schema } from "effect";
import { ApiClient } from "./client";

// ---------------------------------------------------------------------------
// Schemas -- *Base objects are shared between input and response schemas
// to avoid duplication while keeping validation constraints separate.
// ---------------------------------------------------------------------------

const GetUserLightSchema = Schema.Struct({});

const MachineConfigurationBase = {
  cpuCores: Schema.Int.pipe(Schema.between(1, 16)),
  ram: Schema.Int.pipe(Schema.between(1, 64)),
  storage: Schema.Int.pipe(Schema.between(10, 500)),
};
const AccessControlBase = {
  requireEmailAuth: Schema.Boolean,
  publicAccess: Schema.Boolean,
  restrictToTeamMembers: Schema.Boolean,
};

const MachineConfigurationResponse = Schema.Struct(MachineConfigurationBase);
const AccessControlResponse = Schema.Struct(AccessControlBase);

const MachineConfigurationInput = Schema.Struct({
  cpuCores: Schema.optionalWith(MachineConfigurationBase.cpuCores, {}),
  ram: Schema.optionalWith(MachineConfigurationBase.ram, {}),
  storage: Schema.optionalWith(MachineConfigurationBase.storage, {}),
});
const AccessControlInput = Schema.Struct({
  requireEmailAuth: Schema.optionalWith(AccessControlBase.requireEmailAuth, {}),
  publicAccess: Schema.optionalWith(AccessControlBase.publicAccess, {}),
  restrictToTeamMembers: Schema.optionalWith(
    AccessControlBase.restrictToTeamMembers,
    {}
  ),
});

const ProjectBase = {
  name: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(128),
    Schema.nonEmptyString()
  ),
  description: Schema.optionalWith(
    Schema.NonEmptyString.pipe(Schema.maxLength(256)),
    { exact: true }
  ),
};

export const CreateProjectSchema = Schema.Struct({
  ...ProjectBase,
  machineConfiguration: MachineConfigurationInput,
  teamMemberIds: Schema.Array(Schema.NonEmptyString),
  accessControl: AccessControlInput,
});

export const GetProjectSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  ...ProjectBase,
  organizationId: Schema.NonEmptyString,
  createdBy: Schema.NullOr(GetUserLightSchema),
  machineConfiguration: MachineConfigurationResponse,
  teamMembers: Schema.Array(GetUserLightSchema),
  accessControl: AccessControlResponse,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
});

export const GetProjectListItemSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
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
