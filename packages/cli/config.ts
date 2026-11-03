export {
  readConfigFile,
  suggestedLocalConfig,
  writeConfigFile,
} from "./src/config";
export { detectProject } from "./src/config/detect";
export {
  getDeploymentEnv,
  listDeploymentSecrets,
  mergeEnv,
  readSecretsFile,
  removeDeployment,
  removeDeploymentEnvKey,
  setDeploymentEnv,
  writeSecretsFile,
} from "./src/config/secrets";
