# Devver

Terms for local deployment and optional public publishing.

## Language

**Server instance**: A named, independently running Devver server on a developer's machine. _Avoid_: Server package

**CLI target**: The server instance explicitly selected for CLI control. _Avoid_: Public route

**App**: A runnable part of a repository that can be deployed independently. An app can have more than one service. _Avoid_: Package, service

**Service**: One running process within an app, such as an HTTP server or worker. _Avoid_: App

**Deployment**: A published revision of one app with an identity that persists across amendments. _Avoid_: Server instance

**Root deployment**: An independent deployment with no parent. Sharing a repository or Git history with another deployment does not make it a child.

**Child deployment**: A deployment explicitly forked from a particular parent deployment. _Avoid_: Next revision, newer deployment

**Public route**: A stable public address for one deployment, managed by a publishing service. It does not grant access to the server's control interface. _Avoid_: CLI target, control URL

**Devver-managed publishing**: An optional service that issues public routes under a Devver-owned domain. Independently exposing an app through a developer's own service is not a Devver-managed publishing integration. _Avoid_: Remote attachment

**Unpublish**: The deliberate removal of a deployment's public route. A server going offline does not unpublish its deployments. _Avoid_: Stop server, detach

**Suspension**: Devver's restriction of a deployment's public route for a terms-of-use violation. It does not remove the local deployment or change the CLI target. _Avoid_: Unpublish, stop server
