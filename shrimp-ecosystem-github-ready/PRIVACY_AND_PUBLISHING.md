# Privacy & Publishing Checklist

This folder is sanitized for GitHub publishing.

Included:
- Source code under scripts/, dashboard/, config/
- README and .gitignore

Excluded on purpose:
- data/state.json
- ledgers (*.ndjson)
- control snapshots
- push payload outputs
- logs

Before publishing:
1. Fill config placeholders in config/shrimp.config.yaml
2. Keep execution.enable_order_write=false by default
3. Verify no secrets in commit diff
4. Run: git status && git diff --staged
