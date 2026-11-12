# Solutions

Learnings from building cupo, written down so the next change starts from what
already worked. Each entry states the problem, what cupo does and why, and the
lessons that cost time.

| Entry | Covers |
|---|---|
| [security/rls-helpers-and-composite-foreign-keys.md](security/rls-helpers-and-composite-foreign-keys.md) | The three isolation layers (RLS through `private` helpers, composite foreign keys, non-updatable `operator_id`), role-gated tables, and the U7 narrowing of `customer_display` for the guía |
| [database/trigger-ownership.md](database/trigger-ownership.md) | Which layer owns what (KTD5), and why a definer `before insert` trigger must refuse a caller with no rights before it reads another operator's rows |
| [workflow/migration-workflow.md](workflow/migration-workflow.md) | CLI migrations, forward-only fixes, generated types, the PR preflight and the deploy path |
| [testing/isolation-harness.md](testing/isolation-harness.md) | The isolation and role matrices, the pgTAP coverage, the guards and the fail-ability check |
