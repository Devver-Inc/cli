/**
 * Windows named-instance creation supervised by the native Task Scheduler.
 *
 * The task is registered without any trigger, so it starts only on demand:
 * creation never installs logon or boot startup. Restart on failure is bounded
 * by RestartCount/RestartInterval, and readiness is reported only after the
 * registered task is confirmed running with those settings.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { instanceParent, loadInstance } from "../server/identity";
import {
  verifyWindowsPrivate,
  windowsPrivateDirectories,
} from "../server/windows-acl";
import { verifyIdentity } from "./local-server";
import { availablePort } from "./loopback";

const execute = promisify(execFile);
// Each owner/ACL verification spawns a PowerShell command, so a supervised
// server needs a longer readiness budget than a POSIX one.
const READINESS_MS = 20_000;
// Windows command-line quoting: double any backslashes that precede a quote or
// end the value, and escape embedded quotes.
const QUOTED = /(\\*)"/g;
const TRAILING_SLASHES = /\\+$/;

// Get-ScheduledTask surfaces State and MultipleInstances either as generated
// enums or as their documented numeric CIM values depending on the host, so
// both spellings of the same contract are accepted.
const TASK_SCRIPT = `
$ErrorActionPreference = 'Stop'
$task = $env:DEVVER_TASK
if ($env:DEVVER_TASK_ACTION -eq 'register') {
  $action = New-ScheduledTaskAction -Execute $env:DEVVER_EXECUTABLE -Argument $env:DEVVER_ARGUMENTS
  $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  # S4U runs as this user without storing a password and without requiring an
  # interactive desktop session: Interactive would refuse to launch whenever
  # the account is not logged on at a console. RunLevel stays unelevated.
  $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName $task -Action $action -Settings $settings -Principal $principal | Out-Null
} elseif ($env:DEVVER_TASK_ACTION -eq 'start') {
  Start-ScheduledTask -TaskName $task
} elseif ($env:DEVVER_TASK_ACTION -eq 'diagnose') {
  # Readiness failures must say whether the task ever ran, otherwise a task that
  # cannot launch is indistinguishable from a server that will not listen.
  $entry = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  if ($null -eq $entry) { Write-Output 'task not registered' } else {
    $info = Get-ScheduledTaskInfo -TaskName $task -ErrorAction SilentlyContinue
    Write-Output "state=$($entry.State) lastResult=$($info.LastTaskResult) lastRun=$($info.LastRunTime) missed=$($info.NumberOfMissedRuns)"
  }
} elseif ($env:DEVVER_TASK_ACTION -eq 'supervised') {
  $entry = Get-ScheduledTask -TaskName $task
  if ("$($entry.State)" -notin @('Running', '4')) { throw 'Scheduled task is not running' }
  # A trigger-free task reports $null here, and @($null).Count is 1, so an
  # unfiltered count rejects exactly the shape this contract requires.
  $triggers = @($entry.Triggers) | Where-Object { $null -ne $_ }
  if (@($triggers).Count -ne 0) { throw 'Scheduled task has a startup trigger' }
  if ($entry.Settings.RestartCount -ne 3) { throw 'Scheduled task restart is unbounded' }
  if ("$($entry.Settings.MultipleInstances)" -notin @('IgnoreNew', '2')) {
    throw 'Scheduled task allows parallel instances'
  }
} elseif ($env:DEVVER_TASK_ACTION -eq 'remove') {
  if ($null -ne (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)) {
    Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $task -Confirm:$false
  }
  if ($null -ne (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)) {
    throw 'Scheduled task is still registered'
  }
}
`;

async function task(action: string, name: string, command = "", args = "") {
  const result = await execute(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", TASK_SCRIPT],
    {
      timeout: 30_000,
      // A failing task report names the task and its settings; truncating that
      // to ENOBUFS would replace the real reason with a spurious one.
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        DEVVER_TASK_ACTION: action,
        DEVVER_TASK: name,
        DEVVER_EXECUTABLE: command,
        DEVVER_ARGUMENTS: args,
      },
    }
  );
  return result.stdout.trim();
}

/** Never throws: it only explains a readiness failure that already happened. */
async function diagnose(name: string) {
  try {
    return await task("diagnose", name);
  } catch (error) {
    return `task state unavailable: ${error instanceof Error ? error.message : "unknown"}`;
  }
}

function existing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function pinServer(parent: string) {
  const installations = join(dirname(parent), "installations");
  const version = join(installations, pkg.version);
  await windowsPrivateDirectories(installations, version);
  const npm = process.versions.bun === undefined;
  // The npm CLI is split into ESM chunks beside dist/servers; argv[1] may
  // be the extensionless npm bin shim rather than dist/cli.mjs.
  const sourceRoot = npm
    ? dirname(fileURLToPath(import.meta.url))
    : dirname(process.execPath);
  const name = npm ? "server.mjs" : "devver-server.exe";
  const source = join(sourceRoot, "servers", pkg.version, name);
  if (!(await lstat(source)).isFile()) {
    throw new Error("Packaged server must be a regular file");
  }
  const destination = join(version, name);
  const staging = join(version, `.server-${randomUUID()}`);
  const handle = await open(staging, "wx");
  try {
    await verifyWindowsPrivate({ path: staging, kind: "file" });
    await handle.writeFile(await readFile(source));
    await handle.sync();
    try {
      // A complete, fsynced copy becomes visible atomically; never replace a pin.
      await link(staging, destination);
    } catch (error) {
      if (!existing(error)) {
        throw error;
      }
    }
  } finally {
    await handle.close();
    await rm(staging, { force: true });
  }
  await verifyWindowsPrivate({ path: destination, kind: "file" });
  return {
    command: npm ? process.execPath : destination,
    args: npm ? [destination] : [],
  };
}

function quote(value: string) {
  // Task Scheduler hands the argument string to the target process, which
  // parses it with Windows command-line rules.
  const escaped = value
    .replaceAll(QUOTED, '$1$1\\"')
    .replace(TRAILING_SLASHES, (slashes) => slashes + slashes);
  return `"${escaped}"`;
}

export async function create(name: string) {
  if (process.platform !== "win32") {
    // Nothing below is a security boundary off Windows: refuse before any state
    // exists rather than fall back to POSIX mode bits.
    throw new Error("Task Scheduler supervision requires Windows");
  }
  const parent = await instanceParent(name);
  const directory = join(parent, name);
  // Exclusive creation is the duplicate-name gate: nothing belonging to that
  // name is touched. The parent's DACL is already verified owner-only, so the
  // new directory inherits that single rule at creation.
  try {
    await mkdir(directory);
  } catch (error) {
    if (existing(error)) {
      throw new Error(`Server instance '${name}' already exists`);
    }
    throw error;
  }
  const taskName = `devver-${randomUUID()}`;
  let started = false;
  try {
    const instance = await loadInstance(name);
    const port = await availablePort();
    const pinned = await pinServer(parent);
    const service = join(directory, "service.json");
    const handle = await open(service, "wx");
    try {
      await verifyWindowsPrivate({ path: service, kind: "file" });
      await handle.writeFile(
        JSON.stringify({ task: taskName, port, serverVersion: pkg.version })
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await task(
      "register",
      taskName,
      pinned.command,
      [...pinned.args, name, String(port)].map(quote).join(" ")
    );
    await task("start", taskName);
    started = true;
    const url = `http://127.0.0.1:${port}/api/v1`;
    const deadline = Date.now() + READINESS_MS;
    // A readiness failure must say whether nothing ever listened or something
    // listened under another identity: the second means the supervised process
    // resolved its instance state somewhere the creating CLI did not.
    let lastProbe = "no response";
    while (Date.now() < deadline) {
      let target: Awaited<ReturnType<typeof verifyIdentity>> | undefined;
      try {
        target = await verifyIdentity(url);
      } catch (error) {
        lastProbe = `no identity: ${error instanceof Error ? error.message : "unknown"}`;
      }
      if (target) {
        if (target.instanceId === instance.instanceId && target.name === name) {
          // Outside the probe's catch: a broken supervision contract must
          // surface its own reason, not be retried until the budget expires.
          await task("supervised", taskName);
          return url;
        }
        lastProbe = `identity mismatch: answered ${target.name}/${target.instanceId}, expected ${name}/${instance.instanceId}`;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(
      `Server did not return its expected identity while supervised (${await diagnose(taskName)}; last probe: ${lastProbe})`
    );
  } catch (error) {
    // Even if registration failed, stop the unique task before discarding its
    // state. If that fails, keep service.json so the user can stop it by hand.
    try {
      await task("remove", taskName);
      await rm(directory, { recursive: true });
    } catch {
      throw new Error(
        `Server creation failed; instance '${name}' may need recovery: run Stop-ScheduledTask and Unregister-ScheduledTask for ${taskName}, then remove new state at ${directory} before retrying. No readiness was reported`,
        { cause: error }
      );
    }
    throw new Error(
      started
        ? "Server failed readiness; new task was stopped and instance state removed"
        : "Could not install Windows Task Scheduler supervision; new instance state removed",
      { cause: error }
    );
  }
}
