import { TextAttributes } from "@opentui/core";
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import type React from "react";
import { useEffect, useRef, useState } from "react";

import type { Organization } from "../../auth/session";
import type { shortcuts } from "../keys";
import type { CloudTarget } from "../target";
import { scrollbarOptions, theme } from "../theme";

export function useOrganizationSelection({
  organizations = [],
  currentOrganization = null,
  onSwitchOrganization,
}: Pick<
  CloudTarget,
  "organizations" | "currentOrganization" | "onSwitchOrganization"
>) {
  const [orgId, setOrgId] = useState(currentOrganization);
  const [confirmedId, setConfirmedId] = useState(
    currentOrganization ?? organizations[0]?.id
  );
  const [orgPicker, setOrgPicker] = useState(false);
  const [orgIndex, setOrgIndex] = useState(0);
  const [orgError, setOrgError] = useState("");
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);
  const orgList = useRef<ScrollBoxRenderable>(null);
  const currentOrg =
    organizations.find((org) => org.id === orgId) ??
    (orgId !== null && orgId !== "" ? undefined : organizations[0]);

  useEffect(() => {
    if (orgError === "") {
      return undefined;
    }
    const timer = setTimeout(() => {
      setOrgError("");
    }, 4000);
    return () => {
      clearTimeout(timer);
    };
  }, [orgError]);

  useEffect(() => {
    if (!orgPicker) {
      return undefined;
    }
    const choice = organizations[orgIndex];
    const timer = setTimeout(() => {
      if (choice !== undefined) {
        orgList.current?.scrollChildIntoView(`organization-${choice.id}`);
      }
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [orgPicker, orgIndex, organizations]);

  function open() {
    setOrgIndex(
      Math.max(
        0,
        organizations.findIndex((org) => org.id === currentOrg?.id)
      )
    );
    setOrgError("");
    setOrgPicker(true);
  }

  function handle(
    action: keyof typeof shortcuts | undefined,
    key: KeyEvent,
    onExit: () => void
  ) {
    if (switchingRef.current) {
      return;
    }
    if (action === "cancel") {
      setOrgPicker(false);
    } else if (action === "up") {
      setOrgIndex((index) => Math.max(0, index - 1));
    } else if (action === "down") {
      setOrgIndex((index) => Math.min(organizations.length - 1, index + 1));
    } else if (action === "confirm") {
      const choice = organizations[orgIndex];
      if (choice === undefined || onSwitchOrganization === undefined) {
        return;
      }
      if (choice.id === currentOrg?.id) {
        setOrgPicker(false);
        return;
      }
      switchingRef.current = true;
      setSwitching(true);
      setOrgError("");
      setOrgId(choice.id);
      setOrgPicker(false);
      onSwitchOrganization(orgId, choice.id)
        .then(() => {
          setConfirmedId(choice.id);
        })
        .catch(() => {
          setOrgId(orgId);
          setOrgError("Could not switch organization. Check your selection.");
        })
        .finally(() => {
          switchingRef.current = false;
          setSwitching(false);
        });
    } else if (action === "quit" && key.ctrl) {
      onExit();
    }
  }

  return {
    orgId,
    confirmedId,
    orgPicker,
    orgIndex,
    orgError,
    switching,
    orgList,
    currentOrg,
    open,
    handle,
  };
}

export function OrganizationPicker({
  organizations,
  currentOrg,
  orgIndex,
  orgList,
  switching,
  orgError,
}: {
  readonly organizations: readonly Organization[];
  readonly currentOrg?: Organization | undefined;
  readonly orgIndex: number;
  readonly orgList: React.RefObject<ScrollBoxRenderable | null>;
  readonly switching: boolean;
  readonly orgError: string;
}): React.ReactNode {
  return (
    <box
      border
      borderColor={theme.line}
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      paddingX={1}
      title=" organizations "
      titleColor={theme.mint}
    >
      <text fg={theme.muted} height={1} wrapMode="none">
        Select organization · ↑/↓ · Enter · Esc
      </text>
      <scrollbox
        flexGrow={1}
        minHeight={0}
        ref={orgList}
        scrollbarOptions={scrollbarOptions}
      >
        {organizations.length === 0 && (
          <text fg={theme.amber}>
            No organizations available. Run devver auth login.
          </text>
        )}
        {organizations.map((org, index): React.ReactNode => (
          <text
            attributes={
              index === orgIndex ? TextAttributes.BOLD : TextAttributes.NONE
            }
            fg={index === orgIndex ? theme.mint : theme.ink}
            id={`organization-${org.id}`}
            key={org.id}
          >
            {index === orgIndex ? "◆" : " "} {org.name}
            {org.id === currentOrg?.id ? " (current)" : ""}
          </text>
        ))}
      </scrollbox>
      {switching && <text fg={theme.muted}>Switching organization…</text>}
      {orgError !== "" && <text fg={theme.rose}>{orgError}</text>}
    </box>
  );
}
