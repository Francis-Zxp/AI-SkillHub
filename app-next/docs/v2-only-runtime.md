# V2-only runtime

Date: 2026-06-06

AI SkillHub now uses the V2 runtime layout only.

Removed:

```text
app/
AI SkillHub.exe
release/
```

Current runtime:

```text
app-next/runtime/
app-next/data/github_sources/
app-next/reports/
app-next/.skillhub-next/
../skills/
```

Important rules:

1. Do not restore `app/SkillHub.ps1`.
2. Do not restore `app/github_sources`.
3. Do not delete `../skills`; it is the active shared Skill view.
4. Do not commit `app-next/data`, reports, local config, build output, or
   personal Skills.
5. Keep PowerShell runtime scripts in UTF-8 with BOM for Windows PowerShell
   compatibility.
6. Store same-name child Skill conflict choices in local SQLite metadata, not
   in author-owned repositories.

Validation after migration:

```text
pnpm build: passed
cargo test: 41 passed
pnpm tauri build --no-bundle: passed
runtime SkillHub.ps1 -NoPull -ReportOnly: passed
```
