---
"@devver/cli": minor
---

Keep local static deployments independent across revisions and server restarts: two explicit deploys from one checkout serve their own committed revision at their own stable URL, and a restarted server reconciles its durable records with the processes and routes it finds, recovering healthy deployments on their published addresses and reporting the rest degraded instead of ready.
