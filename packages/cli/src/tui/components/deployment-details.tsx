import { TextAttributes } from "@opentui/core";
import type React from "react";

import type { FlatDeployment } from "../deployments";
import { terminalBackground, theme } from "../theme";

function orElse(value: string | null | undefined, fallback: string) {
  const text = value?.trim();
  return text === undefined || text === "" ? fallback : text;
}

function nameOnly(entry: FlatDeployment | undefined) {
  if (entry === undefined) {
    return "unknown deployment";
  }
  const named = entry.displayName?.trim();
  return named === undefined || named === ""
    ? entry.id.slice(0, 8)
    : `${named} (${entry.id.slice(0, 8)})`;
}

// Servers record an ISO instant; an unparsable one is shown as it arrived rather than as a wrong date.
function when(createdAt: string | undefined) {
  if (createdAt === undefined) {
    return "not reported by this server";
  }
  const at = new Date(createdAt);
  return Number.isNaN(at.getTime()) ? createdAt : at.toLocaleString();
}

function how(entry: FlatDeployment, byId: ReadonlyMap<string, FlatDeployment>) {
  if (entry.secondParentId !== undefined) {
    return `merged from ${nameOnly(byId.get(entry.parentId ?? ""))} and ${nameOnly(byId.get(entry.secondParentId))}`;
  }
  return entry.parentId === undefined
    ? "deployed as a root, with no earlier deployment on its history"
    : `deployed on top of ${nameOnly(byId.get(entry.parentId))}`;
}

export function DeploymentDetails({
  entry,
  byId,
}: {
  readonly entry: FlatDeployment;
  readonly byId: ReadonlyMap<string, FlatDeployment>;
}): React.ReactNode {
  const stage =
    entry.stage === null || entry.stage === undefined
      ? ""
      : ` (${entry.stage})`;
  const fields = [
    ["name", orElse(entry.displayName, "unnamed · press r to name it")],
    ["id", entry.id],
    ["commit", entry.commit ?? "not reported by this server"],
    ["subject", orElse(entry.commitSubject, "no commit subject")],
    ["deployed", when(entry.createdAt)],
    ["how", how(entry, byId)],
    ["status", `${entry.status}${stage}`],
    ["url", entry.url ?? "none until ready"],
    ["repository", entry.repositoryId ?? "not reported by this server"],
  ] as const;
  return (
    <box
      alignItems="center"
      height="100%"
      justifyContent="center"
      left={0}
      position="absolute"
      top={0}
      width="100%"
      zIndex={10}
    >
      <box
        backgroundColor={terminalBackground}
        border
        borderColor={theme.line}
        flexDirection="column"
        paddingX={1}
        title=" deployment "
        titleColor={theme.mint}
        width="84%"
      >
        {fields.map(([label, value]): React.ReactNode => (
          <box flexDirection="row" height={1} key={label} width="100%">
            <text wrapMode="none">
              <span attributes={TextAttributes.BOLD} fg={theme.mint}>
                {label.padEnd(11)}
              </span>
              <span fg={theme.ink}>{value}</span>
            </text>
          </box>
        ))}
      </box>
    </box>
  );
}
