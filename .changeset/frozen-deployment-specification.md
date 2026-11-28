---
"@devver-inc/cli": patch
---

Freeze each local deployment's resolved specification before workload preparation so an interrupted first attempt reuses it on recovery. Adopt existing journal specifications without rereading committed configuration. Keep startup reconciliation from withdrawing a workflow deployment that has already resumed while older workloads are restored.
