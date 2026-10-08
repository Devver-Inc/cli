/**
 * Windows-only owner-only instance state.
 *
 * POSIX mode bits are not a Windows security boundary, so this module never
 * inspects them. Instead the shared `devver` root is created *with* a
 * protected, owner-only DACL in a single operation, which rules out the
 * race-prone pattern of creating a directory and repairing its permissions
 * afterwards. Everything below that root is created with ordinary atomic
 * Node calls, inherits that single owner-only access rule, and is verified
 * (owner SID plus every effective access rule) before it is trusted.
 */

import { execFile } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

// oxlint-disable-next-line typescript/strict-void-return -- Node's execFile overload is supported by promisify and retains its rejection semantics.
const execute = promisify(execFile);
const ROOT = "devver";

// Windows PowerShell 5.1 is present on every supported Windows host and its
// .NET Framework exposes Directory.CreateDirectory(path, DirectorySecurity),
// the overload that applies a DACL at creation time.
async function powershell(script: string, variables: Record<string, string>) {
  try {
    const result = await execute(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        timeout: 15_000,
        // A failing ACL report prints the offending path and its rules, which
        // does not fit a small buffer; truncating it to ENOBUFS would replace
        // the real reason with a spurious one.
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        // Paths travel in the environment: they are never interpolated into the script.
        env: { ...process.env, ...variables },
      }
    );
    return result.stdout.trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        "Windows PowerShell is required to secure server instance state",
        { cause: error }
      );
    }
    throw error;
  }
}

// Shared by both scripts: throws unless the path is a real owner-only entry
// whose every effective access rule grants the current user alone.
const CHECK_ENTRY = `
function Confirm-Private([string] $path, [string] $kind, [bool] $protectedAcl) {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if (-not (Test-Path -LiteralPath $path)) {
    # Get-Item would raise an opaque PathNotFound here. Report what this process
    # actually received, so a path handed over wrong is not read as a missing one.
    $parent = [System.IO.Path]::GetDirectoryName($path)
    throw "$path is absent (length $($path.Length), parent '$parent' exists: $([System.IO.Directory]::Exists($parent)))"
  }
  $item = Get-Item -LiteralPath $path -Force
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw "$path is a reparse point"
  }
  if ($kind -eq 'directory' -and -not $item.PSIsContainer) { throw "$path is not a directory" }
  if ($kind -eq 'file' -and $item.PSIsContainer) { throw "$path is not a file" }
  # GetAccessControl() comes from the already-resolved item rather than Get-Acl:
  # that cmdlet lives in Microsoft.PowerShell.Security, whose autoload failed in
  # CI and turned an ordinary permission check into a missing-command error.
  $acl = $item.GetAccessControl()
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid) {
    throw "$path is not owned by this user"
  }
  if ($protectedAcl -and -not $acl.AreAccessRulesProtected) {
    throw "$path inherits access rules"
  }
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -eq 0) { throw "$path has no access rules" }
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -ne $sid) { throw "$path grants another identity" }
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
      throw "$path has a non-allow rule"
    }
    if ($rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
      throw "$path grants unexpected rights"
    }
  }
}
`;

const CREATE_ROOT = `
$ErrorActionPreference = 'Stop'
${CHECK_ENTRY}
$base = [System.Environment]::GetFolderPath('LocalApplicationData')
if ([string]::IsNullOrEmpty($base)) { throw 'Local application data is unavailable' }
$baseItem = Get-Item -LiteralPath $base -Force
if (-not $baseItem.PSIsContainer -or ($baseItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
  throw 'Local application data is not a plain directory'
}
$path = [System.IO.Path]::Combine($base, $env:DEVVER_ACL_ROOT)
if (-not [System.IO.Directory]::Exists($path)) {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow')
  $acl.AddAccessRule($rule)
  [System.IO.Directory]::CreateDirectory($path, $acl) | Out-Null
}
Confirm-Private $path 'directory' $true
Write-Output $path
`;

// Listing state must never create the protected root used by creation.
const FIND_ROOT = `
$ErrorActionPreference = 'Stop'
${CHECK_ENTRY}
$base = [System.Environment]::GetFolderPath('LocalApplicationData')
if ([string]::IsNullOrEmpty($base)) { throw 'Local application data is unavailable' }
$baseItem = Get-Item -LiteralPath $base -Force
if (-not $baseItem.PSIsContainer -or ($baseItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
  throw 'Local application data is not a plain directory'
}
$path = [System.IO.Path]::Combine($base, $env:DEVVER_ACL_ROOT)
try { $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop }
catch [System.Management.Automation.ItemNotFoundException] { return }
Confirm-Private $path 'directory' $true
Write-Output $path
`;

// Windows PowerShell 5.1 writes a JSON array to the pipeline as one item with
// enumeration suppressed, so neither `@(...)` nor `ForEach-Object` unrolls it:
// the loop variable binds the whole array and `$entry.path` member-enumerates
// every path into one space-joined string. Assigning first, then indexing by
// position, does not depend on pipeline enumeration at all.
const VERIFY_ENTRIES = `
$ErrorActionPreference = 'Stop'
${CHECK_ENTRY}
$entries = $env:DEVVER_ACL_ENTRIES | ConvertFrom-Json
for ($i = 0; $i -lt @($entries).Count; $i++) {
  $entry = @($entries)[$i]
  Confirm-Private $entry.path $entry.kind $false
}
`;

function requireWindows() {
  if (process.platform !== "win32") {
    throw new Error("Owner-only Windows ACLs require Windows");
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node filesystem errors arrive untyped; inspect only the EEXIST code.
function existing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/**
 * Verifies entries created below the protected root. Each inherits the root's
 * single owner-only rule, so protection is checked on the root alone.
 */
export async function verifyWindowsPrivate(
  ...entries: { path: string; kind: "directory" | "file" }[]
) {
  requireWindows();
  for (const entry of entries) {
    const stat = await lstat(entry.path);
    if (
      stat.isSymbolicLink() ||
      (entry.kind === "directory" ? !stat.isDirectory() : !stat.isFile())
    ) {
      throw new Error(`${entry.path} is not a plain ${entry.kind}`);
    }
  }
  try {
    await powershell(VERIFY_ENTRIES, {
      DEVVER_ACL_ENTRIES: JSON.stringify(entries),
    });
  } catch (error) {
    throw new Error(
      "Server instance state must be an owner-only Windows directory tree",
      { cause: error }
    );
  }
}

/**
 * Creates directories that inherit the verified root's single owner-only rule,
 * then verifies them together.
 */
export async function windowsPrivateDirectories(...paths: string[]) {
  requireWindows();
  for (const path of paths) {
    try {
      await mkdir(path);
    } catch (error) {
      if (!existing(error)) {
        throw error;
      }
    }
  }
  await verifyWindowsPrivate(
    ...paths.map((path) => ({ path, kind: "directory" }) as const)
  );
}

// Verifying the protected root once per process keeps the PowerShell cost of a
// single command bounded; every path below it is still verified on each use.
let servers: Promise<string> | undefined;

async function resolveServers() {
  // LOCALAPPDATA is per-user and resolved from the OS known folder, never from
  // an overridable variable. An XDG override would place instance state in a
  // directory whose trust cannot be established here, so it fails closed.
  if (
    process.env.XDG_DATA_HOME !== undefined &&
    process.env.XDG_DATA_HOME !== ""
  ) {
    throw new Error(
      "Windows server state does not accept XDG_DATA_HOME overrides"
    );
  }
  let root: string;
  try {
    root = await powershell(CREATE_ROOT, { DEVVER_ACL_ROOT: ROOT });
  } catch (error) {
    throw new Error(
      "Server state requires an owner-only Windows directory under local application data",
      { cause: error }
    );
  }
  if (basename(root) !== ROOT) {
    throw new Error("Windows local application data directory is unavailable");
  }
  const directory = join(root, "servers");
  await windowsPrivateDirectories(directory);
  return directory;
}

/**
 * The verified owner-only parent of every named instance's state, under
 * `%LOCALAPPDATA%\devver`.
 */
export async function windowsServersDirectory() {
  requireWindows();
  servers ??= resolveServers();
  return await servers;
}

/** Resolve existing state without creating the user root or servers directory. */
export async function existingWindowsServersDirectory(): Promise<
  string | undefined
> {
  requireWindows();
  if (
    process.env.XDG_DATA_HOME !== undefined &&
    process.env.XDG_DATA_HOME !== ""
  ) {
    throw new Error(
      "Windows server state does not accept XDG_DATA_HOME overrides"
    );
  }
  const root = await powershell(FIND_ROOT, { DEVVER_ACL_ROOT: ROOT });
  if (root === "") {
    return undefined;
  }
  if (basename(root) !== ROOT) {
    throw new Error("Windows local application data directory is unavailable");
  }
  const directory = join(root, "servers");
  try {
    await lstat(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  await verifyWindowsPrivate({ path: directory, kind: "directory" });
  return directory;
}
