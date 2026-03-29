import { Effect, Schema } from "effect";
import { ApiClient } from "./client";

export const CreateRepositorySchema = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
});

export const ServiceConfigSchema = Schema.Struct({
  root: Schema.optional(Schema.String),
  install: Schema.optional(Schema.String),
  skipInstall: Schema.optional(Schema.Boolean),
  build: Schema.String.pipe(Schema.minLength(1)),
  start: Schema.String.pipe(Schema.minLength(1)),
});

export const ServicesSchema = Schema.Struct({
  api: Schema.optional(ServiceConfigSchema),
  web: Schema.optional(ServiceConfigSchema),
});

export const CreateDeploymentSchema = Schema.Struct({
  repo: Schema.String.pipe(Schema.minLength(1)),
  branch: Schema.String.pipe(Schema.minLength(1)),
  commit: Schema.optional(Schema.String),
  service: ServicesSchema,
  links: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.Record({ key: Schema.String, value: Schema.String }),
    })
  ),
  env: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String })
  ),
});

export const ControlPm2ProcessSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
});

// Response Schemas
export const GetRepoSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  pushUrl: Schema.String,
  projectId: Schema.String,
  createdAt: Schema.DateTimeUtc,
});

export const PM2ProcessStatusSchema = Schema.Literal(
  "online",
  "stopped",
  "errored",
  "stopping"
);

export const PM2ProcessSchema = Schema.Struct({
  name: Schema.String,
  pm_id: Schema.Number,
  status: PM2ProcessStatusSchema,
  cpu: Schema.Number,
  memory: Schema.Number,
});

export const ServiceDeployResultSchema = Schema.Struct({
  port: Schema.Number,
  url: Schema.String,
});

export const GetAgentDeploymentSchema = Schema.Struct({
  deploymentId: Schema.String,
  repo: Schema.String,
  branch: Schema.String,
  commit: Schema.String,
  service: Schema.Record({
    key: Schema.Literal("api", "web"),
    value: ServiceDeployResultSchema,
  }),
  process: Schema.NullOr(PM2ProcessSchema),
});

export const LogEntrySchema = Schema.Struct({
  service: Schema.String,
  level: Schema.String,
  message: Schema.String,
  timestamp: Schema.String,
});

export const GetLogsSchema = Schema.Struct({
  logs: Schema.Array(LogEntrySchema),
});

export const RestoreResultSchema = Schema.Struct({
  restoredRepos: Schema.Number,
  restoredDeployments: Schema.Number,
});

export const PM2ActionSchema = Schema.Literal("start", "stop", "restart");

export const ControlPm2ProcessResultSchema = Schema.Struct({
  success: Schema.Boolean,
  name: Schema.String,
  action: PM2ActionSchema,
});

export type CreateRepositoryDto = Schema.Schema.Type<
  typeof CreateRepositorySchema
>;
export type CreateDeploymentDto = Schema.Schema.Type<
  typeof CreateDeploymentSchema
>;
export type ControlPm2ProcessDto = Schema.Schema.Type<
  typeof ControlPm2ProcessSchema
>;
export type GetRepoDto = Schema.Schema.Type<typeof GetRepoSchema>;
export type GetAgentDeploymentDto = Schema.Schema.Type<
  typeof GetAgentDeploymentSchema
>;
export type GetLogsDto = Schema.Schema.Type<typeof GetLogsSchema>;
export type RestoreResultDto = Schema.Schema.Type<typeof RestoreResultSchema>;
export type ControlPm2ProcessResultDto = Schema.Schema.Type<
  typeof ControlPm2ProcessResultSchema
>;

export const listRepos = (projectId: string) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.get(
      `/projects/${projectId}/repos`,
      Schema.Array(GetRepoSchema)
    );
  });

export const createRepository = (
  projectId: string,
  body: CreateRepositoryDto
) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.post(`/projects/${projectId}/repos`, body, GetRepoSchema);
  });

export const deleteRepo = (projectId: string, name: string) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.delete(
      `/projects/${projectId}/repos/${encodeURIComponent(name)}`,
      Schema.Void
    );
  });

export const createDeployment = (
  projectId: string,
  body: CreateDeploymentDto
) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.post(
      `/projects/${projectId}/deployments`,
      body,
      GetAgentDeploymentSchema
    );
  });

export const listDeployments = (projectId: string) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.get(
      `/projects/${projectId}/deployments`,
      Schema.Array(GetAgentDeploymentSchema)
    );
  });

export const removeDeployment = (projectId: string, deploymentId: string) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.delete(
      `/projects/${projectId}/deployments/${encodeURIComponent(deploymentId)}`,
      Schema.Void
    );
  });

export const getDeploymentLogs = (projectId: string, deploymentId: string) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.get(
      `/projects/${projectId}/deployments/${encodeURIComponent(deploymentId)}/logs`,
      GetLogsSchema
    );
  });

export const startPm2Process = (
  projectId: string,
  body: ControlPm2ProcessDto
) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.post(
      `/projects/${projectId}/pm2/start`,
      body,
      ControlPm2ProcessResultSchema
    );
  });

export const stopPm2Process = (projectId: string, body: ControlPm2ProcessDto) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.post(
      `/projects/${projectId}/pm2/stop`,
      body,
      ControlPm2ProcessResultSchema
    );
  });

export const restartPm2Process = (
  projectId: string,
  body: ControlPm2ProcessDto
) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.post(
      `/projects/${projectId}/pm2/restart`,
      body,
      ControlPm2ProcessResultSchema
    );
  });

export const restoreState = (projectId: string) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.post(
      `/projects/${projectId}/restore`,
      {},
      RestoreResultSchema
    );
  });
