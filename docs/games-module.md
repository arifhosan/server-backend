# Games module

Design and rationale: `docs/superpowers/specs/2026-11-24-game-tracker-design.md`. `DB_SYNC` stays off, so every schema change below is applied by hand before deploy.

```sql
ALTER TABLE user ADD COLUMN timezone VARCHAR(64) NOT NULL DEFAULT 'Europe/Berlin';
```
