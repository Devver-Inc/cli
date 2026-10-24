---
"@devver-inc/cli": patch
---

Treat stopping an already-stopped server as success, so `devver server stop` and `remove` work on instances whose process already died.
