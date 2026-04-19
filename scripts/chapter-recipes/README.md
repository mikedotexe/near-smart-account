# scripts/chapter-recipes/

Scripts kept here solely so the **archive chapter Recipes sections**
remain reproducible. Each script is:

- referenced from one or more archive files under
  [`md-CLAUDE-chapters/`](../../md-CLAUDE-chapters/)
  (`archive-*.md` or chapters 01–13, per the archive classification
  in [`START-HERE` → README §Reading-paths](../../README.md))
- superseded by a more general helper for new work
- still functional — you can run them end-to-end against the shared
  testnet rig to reproduce chapter-era live traces

## What lives here

| Script | Used by | Superseded by |
|---|---|---|
| `send-step-echo-demo.mjs` | chapters 03, 06, 07, 10 Recipes | [`../send-register-step-multi.mjs`](../send-register-step-multi.mjs) |
| `send-step-mixed-demo.mjs` | `md-CLAUDE-chapters/archive-staged-call-lineage.md` | [`../send-register-step-multi.mjs`](../send-register-step-multi.mjs) |
| `send-balance-trigger-wrap-demo.mjs` | `md-CLAUDE-chapters/archive-real-world-adapter-lineage.md` | [`../send-balance-trigger-router-demo.mjs`](../send-balance-trigger-router-demo.mjs) + the balance-trigger flagships in [`../../examples/`](../../examples/) |

## For new work

Don't reach for these. Instead:

- Registered-step batches: [`../send-register-step-multi.mjs`](../send-register-step-multi.mjs)
- Automation demos: [`../send-balance-trigger-router-demo.mjs`](../send-balance-trigger-router-demo.mjs) or the flagships in [`../../examples/`](../../examples/)
- Writing a new flagship: [`../../FLAGSHIP-HOWTO.md`](../../FLAGSHIP-HOWTO.md)
