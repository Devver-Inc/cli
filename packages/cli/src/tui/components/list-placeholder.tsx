import type React from "react";

import { theme } from "../theme";

export function ListPlaceholder({
  kind,
  empty,
  repositoryId,
}: {
  readonly kind: "loading" | "loaded" | "failed" | "unsupported";
  readonly empty: boolean;
  readonly repositoryId: string | undefined;
}): React.ReactNode {
  if (kind === "loading") {
    return <text fg={theme.muted}>Loading deployments…</text>;
  }
  if (kind === "failed") {
    return (
      <text fg={theme.rose}>
        Could not load deployments from this server. Run devver server status.
      </text>
    );
  }
  if (kind === "unsupported") {
    return (
      <text fg={theme.muted}>
        Deployment listing is unavailable on this server. Use a server created
        with a current build.
      </text>
    );
  }
  if (!empty) {
    return null;
  }
  return (
    <text fg={theme.muted}>
      {repositoryId === undefined
        ? "No deployments on this server. Run devver deploy from a Git checkout."
        : "No deployments for this repository. Run devver deploy here."}
    </text>
  );
}
