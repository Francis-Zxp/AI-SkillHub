# AI SkillHub Parent Isolation Compatibility Note

This filename is retained so older documentation links do not break. The manual
child-conflict selector has been superseded by parent-source isolation.

## Current Rule

- A repository/source is one parent Skill namespace.
- Every non-empty source receives one canonical `[ROUTER-HUB]` entry, even when it has only one child.
- The parent lists each `[CHILD-SKILL]` with its exact source-scoped path and selects the child automatically from the user's task.
- A same-name child in another parent is unrelated and can never replace it.
- Codex, Claude and Antigravity receive the same parent-first catalog.
- Author repositories are never edited.

The previous `skill_conflict_choices` table remains readable for migration and
rollback, but current routing does not ask the user to pick a default and does
not generate global `[CONFLICT-DISPATCHER]` or source-qualified alias Skills.
AI SkillHub repair removes only its own stale generated dispatchers; it does not
delete author files.

See `../docs/skill-router-standard.md` for the normative product contract.
