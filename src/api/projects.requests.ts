import { Effect, Schema } from "effect";
import { ApiClient } from "./client";

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
  createdBy: Schema.NullOr(GetUserLightSchema), // define this separately
  machineConfiguration: MachineConfigurationResponse,
  teamMembers: Schema.Array(GetUserLightSchema),
  accessControl: AccessControlResponse,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
});

export const GetProjectsSchema = Schema.Array(GetProjectSchema);

type CreateProjectDto = Schema.Schema.Type<typeof CreateProjectSchema>;

export const getProjects = Effect.gen(function* () {
  const api = yield* ApiClient;
  return yield* api.get("/projects", GetProjectsSchema);
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
