# Infer ordinary deployment parents from Git history

An ordinary local deploy records the nearest ready deployment of the same checkout on its commit's first-parent history as its single parent; absent such an ancestor, it is a root. Git commits alone do not become deployment nodes. First-parent traversal is deterministic for merge commits, while two-parent deployment lineage remains reserved for an explicit Devver merge; repeated deployments of the same commit are siblings, not each other's parents. Existing deployment records are not rewritten.
