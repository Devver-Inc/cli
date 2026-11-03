import { basename } from "node:path";

const UNSAFE_IN_ARGUMENT = /["'`$\r\n]/u;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const DEPLOYMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface DaemonSpec {
  readonly command: readonly string[];
  readonly dir: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly port: number;
}

export function safeDeploymentId(deploymentId: string) {
  if (!DEPLOYMENT_ID.test(deploymentId)) {
    throw new Error("A deployment name must be a UUID");
  }
  return deploymentId;
}

export function tomlLiteral(value: string) {
  if (UNSAFE_IN_ARGUMENT.test(value)) {
    throw new Error(
      "A deployment path cannot contain quotes, expansions or newlines"
    );
  }
  return value;
}

export function shellArgument(argument: string) {
  if (
    UNSAFE_IN_ARGUMENT.test(argument) ||
    (process.platform === "win32"
      ? /[%!^&|<>]/u.test(argument)
      : argument.includes("\\"))
  ) {
    throw new Error(
      "A deployment command cannot contain quotes, expansions or newlines"
    );
  }
  return `"${argument}"`;
}

export function proxySettings(port: number) {
  return `[settings.proxy]
enable = true
https = false
port = ${port}
auto_trust = false
sync_hosts = false
dns = false
tld = "localhost"
host = "127.0.0.1"
`;
}

// Pitchfork limits project labels to 63 characters.
export function projectLabel(instanceDirectory: string) {
  return basename(instanceDirectory)
    .toLowerCase()
    .replaceAll(/[_-]+/gu, "-")
    .replace(/-$/u, "")
    .slice(0, 63)
    .replace(/-$/u, "");
}

function daemonRun(spec: DaemonSpec) {
  const command = spec.command
    .map((argument) => shellArgument(argument))
    .join(" ");
  const variables = Object.entries(spec.env ?? {});
  for (const [name] of variables) {
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new Error("A deployment environment variable name is invalid");
    }
  }
  if (process.platform === "win32") {
    const assignments = variables
      .map(([name, value]) => `set ${shellArgument(`${name}=${value}`)}`)
      .join(" && ");
    return assignments === "" ? command : `${assignments} && ${command}`;
  }
  const environment = variables
    .map(([name, value]) => `${name}=${shellArgument(value)}`)
    .join(" ");
  return environment === "" ? command : `${environment} ${command}`;
}

// Pitchfork rejects instance hostnames when its `dir` is a separate worktree,
// so each daemon keeps the instance directory and changes into its workload.
export function daemonEntry(
  deploymentId: string,
  spec: DaemonSpec,
  instanceDirectory: string
) {
  const changeDirectory = process.platform === "win32" ? "cd /d" : "cd";
  return `[daemons."${safeDeploymentId(deploymentId)}"]
run = '${changeDirectory} ${shellArgument(spec.dir)} && ${daemonRun(spec)}'
dir = '${tomlLiteral(instanceDirectory)}'
port = { expect = [${spec.port}], bump = false }
`;
}

export function manifestText(options: {
  readonly daemons: ReadonlyMap<string, DaemonSpec>;
  readonly instanceDirectory: string;
  readonly proxyPort: number;
}) {
  const entries = [...options.daemons].map(([deploymentId, spec]) =>
    daemonEntry(deploymentId, spec, options.instanceDirectory)
  );
  const settings =
    options.proxyPort === 0 ? "" : proxySettings(options.proxyPort);
  return `${settings}\n${entries.join("\n")}`;
}
