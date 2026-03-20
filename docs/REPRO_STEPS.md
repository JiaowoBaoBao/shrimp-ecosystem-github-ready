# REPRO_STEPS

```bash
cd shrimp-ecosystem-github-ready
node scripts/run_task.mjs seed_state
node scripts/run_task.mjs round_tick
node scripts/run_task.mjs audit_replay
node scripts/run_task.mjs ab_runner
node scripts/run_task.mjs export_submission_bundle
```

> Note: GitHub-ready package intentionally excludes real runtime state/ledger data.
