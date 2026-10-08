# Devver

Terms for local deployment and optional public publishing.

## Language

**Server instance**: A named, independently running Devver server on a developer's machine. _Avoid_: Server package

**CLI target**: The server instance explicitly selected for CLI control. _Avoid_: Public route

**Deployment**: A published revision of a project with an identity that persists across amendments. _Avoid_: Server instance

**Public route**: A stable public address for one deployment, managed by a publishing service. It does not grant access to the server's control interface. _Avoid_: CLI target, control URL

**Devver-managed publishing**: An optional service that issues public routes under a Devver-owned domain. Independently exposing an app through a developer's own service is not a Devver-managed publishing integration. _Avoid_: Remote attachment

**Unpublish**: The deliberate removal of a deployment's public route. A server going offline does not unpublish its deployments. _Avoid_: Stop server, detach

**Suspension**: Devver's restriction of a deployment's public route for a terms-of-use violation. It does not remove the local deployment or change the CLI target. _Avoid_: Unpublish, stop server
