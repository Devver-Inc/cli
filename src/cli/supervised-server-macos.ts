import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { instanceParent, loadInstance } from "../server/identity";
import { verifyIdentity } from "./local-server";
import { availablePort } from "./loopback";
import { pinServer } from "./supervised-server-posix";

const execute = promisify(execFile);
const PRIVATE_DIRECTORY = 0o700;

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plist(
  label: string,
  command: string,
  args: string[],
  data: string,
  directory: string
) {
  const argumentsXml = [command, ...args]
    .map((arg) => `<string>${escapeXml(arg)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${escapeXml(label)}</string>
<key>ProgramArguments</key><array>${argumentsXml}</array>
<key>EnvironmentVariables</key><dict><key>XDG_DATA_HOME</key><string>${escapeXml(data)}</string></dict>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${escapeXml(join(directory, "server.log"))}</string>
<key>StandardErrorPath</key><string>${escapeXml(join(directory, "server.err"))}</string>
</dict></plist>
`;
}

async function launchctl(...args: string[]) {
  // `launchctl print <domain>` dumps every registered service of the user domain.
  await execute("launchctl", args, {
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function loaded(domain: string, label: string) {
  try {
    await launchctl("print", `${domain}/${label}`);
    return true;
  } catch {
    // A failed print is only evidence of absence if the user's domain is reachable.
    await launchctl("print", domain);
    return false;
  }
}

async function removeFailedInstance(
  domain: string,
  label: string,
  directory: string
) {
  try {
    await launchctl("bootout", `${domain}/${label}`);
  } catch {
    // bootstrap may have failed before registration; verify rather than assume.
  }
  if (await loaded(domain, label)) {
    throw new Error("Launchd job remains registered");
  }
  await rm(directory, { recursive: true });
}

export async function create(name: string) {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("macOS user ID is unavailable");
  }
  const domain = `gui/${uid}`;
  const parent = await instanceParent(name);
  const directory = join(parent, name);
  // Exclusive name claim: a duplicate never touches the existing state or job.
  try {
    await mkdir(directory, { mode: PRIVATE_DIRECTORY });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Server instance '${name}' already exists`);
    }
    throw error;
  }
  const label = `com.devver.server.${randomUUID()}`;
  let bootstrapped = false;
  try {
    const instance = await loadInstance(name);
    const port = await availablePort();
    const pinned = await pinServer(parent);
    const data =
      process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    const manifest = join(directory, "service.plist");
    const handle = await open(manifest, "wx", 0o600);
    try {
      await handle.writeFile(
        plist(
          label,
          pinned.command,
          [...pinned.args, name, String(port)],
          data,
          directory
        )
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    const service = await open(join(directory, "service.json"), "wx", 0o600);
    try {
      await service.writeFile(
        JSON.stringify({ label, port, serverVersion: pkg.version })
      );
      await service.sync();
    } finally {
      await service.close();
    }
    // The manifest lives in private instance data, not ~/Library/LaunchAgents:
    // launchd loads the job into the current user session only, never at login.
    await launchctl("bootstrap", domain, manifest);
    bootstrapped = true;
    await launchctl("kickstart", `${domain}/${label}`);
    const url = `http://127.0.0.1:${port}/api/v1`;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const target = await verifyIdentity(url);
        if (
          target.instanceId === instance.instanceId &&
          target.name === name &&
          (await loaded(domain, label))
        ) {
          return url;
        }
      } catch {
        // The child may not yet be listening; only a verified identity is ready.
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(
      "Server did not return its expected identity while supervised"
    );
  } catch (error) {
    try {
      await removeFailedInstance(domain, label, directory);
    } catch {
      throw new Error(
        `Server creation failed; instance '${name}' may need recovery: run launchctl bootout ${domain}/${label}, then remove new state at ${directory} before retrying. No readiness was reported`,
        { cause: error }
      );
    }
    throw new Error(
      bootstrapped
        ? "Server failed readiness; new launchd job was removed and instance state removed"
        : "Could not install macOS launchd user supervision; new instance state removed",
      { cause: error }
    );
  }
}
