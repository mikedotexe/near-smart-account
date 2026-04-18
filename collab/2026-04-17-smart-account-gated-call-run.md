# 2026-04-17 · Smart-account gated-call testnet run

This log captures the live testnet run for the first smart-account-side
staged-execution experiment.

At the time of the run, the contract methods were still named
`gated_call` / `conduct`. The current codebase now exposes the same primitive
as `stage_call` / `run_sequence`.

## Goal

Prove not only that yielded callbacks can be resumed in a chosen order, but
that the `smart-account` contract can order real downstream cross-contract
work:

- multi-action tx creates four pending yielded calls
- a later sequence run chooses a nontrivial order
- each downstream `echo_log` runs before the next label is resumed

## Shared rig

- `smart-account.x.mike.testnet`
- `echo.x.mike.testnet`
- `echo-b.x.mike.testnet`
- `router.x.mike.testnet`
- `yield-sequencer.x.mike.testnet`

## Run artifacts

### Deployment

| Item | Value |
|---|---|
| Deploy time | 2026-04-17T23:13Z |
| Deployer | `x.mike.testnet` |
| Smart-account deploy tx | `GP2aLJ8B5M5gMVgw8vLc5zrF4L1hzbxBegXJPRSNUHvC` at block `246221149` |
| Authorized runner | `mike.testnet` via `7p9bUnAL96eyjPn6rTLzg3oKiX8RU8PZovqryXikDBZS` at block `246221264` |
| Owner nuance | this run happened before `deploy-testnet.sh` switched to `new_with_owner(...)`, so owner-only calls still had to be signed by the contract account |

### Transactions

| Kind | Tx hash | Included block | Receipt / downstream blocks | Notes |
|---|---|---|---|---|
| Probe: staged-call batch | `Fn5tph4CuQxRCkw7c6qqqQyWXSuAaep8ckEZdPpepkWe` | `246221274` | receipt `246221275` | historical method name `gated_call`; `3 x 60 TGas` outer actions with `--call-gas 940`; first action failed `Exceeded the prepaid gas` |
| Probe: staged-call batch | `3K85KEmv8w4gZnMCKbodnVfYJ1fWCRFELo9TbMSEac2w` | `246221327` | receipt `246221328` | historical method name `gated_call`; `3 x 320 TGas` outer actions with `--call-gas 280`; first action failed `Exceeded the prepaid gas` |
| Probe: staged-call batch | `6smJpHnQSNuBsKEFeEU8aZ7zyiW6vj6XB7xohyzeytLG` | `246221465` | receipt `246221466`, then yielded callbacks auto-woke | historical method name `gated_call`; `4 x 333 TGas` outer actions with `--call-gas 200`; contract stored no lasting pending state because each yielded callback woke immediately with `PromiseError::Failed` |
| staged-call batch | `51quobuDJbeS2k7mMDRpwmjobeo1iRn1qnQDVQUeiJMk` | `246221934` | smart-account receipt `246221935`; resumed echoes at `246222024`, `246222027`, `246222030`, `246222033` | success case: `4 x 250 TGas` outer actions = exact `1 PGas` tx envelope; labels `alpha`, `beta`, `gamma`, `delta` |
| sequence run | `uq3mGK6H6JqJuVBZVPpTpFpEkuekEnhKwinJM4yssNT` | `246222021` | sequence receipt `246222022` | historical method name `conduct`; returned `4`; declared order `beta -> delta -> alpha -> gamma` |

### Ordering proof

The original batch tx is the real proof surface. `EXPERIMENTAL_tx_status`
renders the receipt tree in child order, but the *actual* resume / downstream
ordering becomes clear from block heights:

| Label | Resume callback block | Downstream `echo_log` block | Finish callback block |
|---|---|---|---|
| `beta` | `246222023` (`5Av8G2...PQf5`) | `246222024` (`DYyN9Y...Mbeo`) | `246222025` (`huNECG...MquX`) |
| `delta` | `246222026` (`5EHzRN...akDB`) | `246222027` (`G2BpMP...PHkC`) | `246222028` (`BZG1EE...15z4`) |
| `alpha` | `246222029` (`94Fuzj...QrEJ`) | `246222030` (`9NUCWZ...yHNr`) | `246222031` (`GX4aRP...NMu8`) |
| `gamma` | `246222032` (`D2sxRv...psHH`) | `246222033` (`EGV17E...De3q`) | `246222034` (`7t4J9A...QhkS`) |

That matches the declared sequence order exactly:

`beta -> delta -> alpha -> gamma`

### Key takeaways

- The new PV 83 `1 PGas` envelope is usable for a smart-account multi-action
  tx: the successful batch used `4 x 250 TGas = 1000 TGas` exactly.
- The stable yielded-callback shape is *not* "one action at 940 TGas". The
  high-gas probes showed two distinct failure modes:
  - too little outer gas for the requested yield callback: immediate
    `Exceeded the prepaid gas`
  - pushing per-action gas up to `333 TGas`: yielded callbacks woke
    immediately with `PromiseError::Failed` instead of remaining pending
- The practical live recipe today is:
  `./scripts/send-staged-echo-demo.mjs alpha:1 beta:2 gamma:3 delta:4 --action-gas 250 --call-gas 30 --sequence-order beta,delta,alpha,gamma`

### Review commands

```bash
# successful exact-max run
./scripts/trace-tx.mjs 51quobuDJbeS2k7mMDRpwmjobeo1iRn1qnQDVQUeiJMk mike.testnet --wait FINAL
./scripts/trace-tx.mjs uq3mGK6H6JqJuVBZVPpTpFpEkuekEnhKwinJM4yssNT mike.testnet --wait FINAL
./scripts/receipt-to-tx.mjs DYyN9YYZgkRxDtHKvrPGBgwdiLDp9EE3QiXL3tE5Mbeo
./scripts/receipt-to-tx.mjs G2BpMPnhQRG5AqHaHyk8gKgnZiTVFfYvhiQvKfEbPHkC
./scripts/receipt-to-tx.mjs 9NUCWZ9ugMY3DFzCs2HyKgyKzdvJL5W5Fso1Q7rcyHNr
./scripts/receipt-to-tx.mjs EGV17EG8BJKpSSmiFZdNoAdrPHgeBcX25CsrsnxqDe3q
./scripts/account-history.mjs smart-account.x.mike.testnet --limit 10 --function-call
```
