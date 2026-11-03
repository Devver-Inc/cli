import { Schema } from "effect";

import type { LocalDeploymentStatus } from "../api/local-deploy.requests";
import { readConfig } from "../config/api";
import { Storage } from "../storage";

const Id = Schema.String.check(Schema.isUUID(4));
const Ids = Schema.Array(Id);
const decodeIds = Schema.decodeUnknownSync(Ids);

const pathFor = (instanceId: string) =>
  `completion/local/${Schema.decodeSync(Id)(instanceId)}.json`;

export async function saveLocalDeployments(
  instanceId: string,
  deployments: readonly LocalDeploymentStatus[]
) {
  await Storage.write(
    pathFor(instanceId),
    JSON.stringify(
      deployments
        .filter((deployment) => deployment.status === "ready")
        .map((deployment) => deployment.deploymentId)
    )
  );
}

export async function localDeploymentIds() {
  const target = (await readConfig())["local-target"];
  if (target === undefined) {
    return [];
  }
  const path = pathFor(target.instanceId);
  if (!(await Storage.fileExists(path))) {
    return [];
  }
  return decodeIds(JSON.parse(await Storage.readToString(path)));
}
