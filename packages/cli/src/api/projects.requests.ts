import { Effect, Schema } from "effect";

import {
  DatabaseType,
  MachineConfigurationBase,
  OverlayAccessControlBase,
  ProjectDescriptionField,
  ProjectNameField,
  validateCreateProject,
} from "../domain/project";
import type { CreateProjectDto, InvalidProjectInput } from "../domain/project";
import { ApiClient } from "./client";
import type { ApiRequestError } from "./client";

// Response schemas share domain constraints with outgoing project settings.

const GetUserLightSchema = Schema.Struct({
  id: Schema.String,
  email: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});

const MachineConfigurationResponse = Schema.Struct(MachineConfigurationBase);
const OverlayAccessControlResponse = Schema.Struct(OverlayAccessControlBase);

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

const ProjectBase = {
  name: ProjectNameField,
  description: ProjectDescriptionField,
};

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

// Request functions

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
): Effect.Effect<
  CreateProjectResponse,
  ApiRequestError | InvalidProjectInput,
  ApiClient
> =>
  Effect.gen(function* () {
    const input = yield* validateCreateProject(dto);
    const api = yield* ApiClient;
    return yield* api.post("/projects", input, CreateProjectResponseSchema);
  });

export const deleteProjectById = (id: string) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.delete(`/projects/${id}`, Schema.Void);
  });
