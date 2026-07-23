# AI SkillHub Skill Conflict Selector

This document is the stable product rule for duplicate child Skill names.

## Problem

Different GitHub sources can legitimately contain child Skills with the same `name`.
For example:

- `Nature-Paper-Skills / figure-planner`
- `PaperSpine / figure-planner`

This is an exact callable-name collision, not a semantic-similarity judgment.
AI SkillHub must not delete, rename, or overwrite any candidate.

## Identity Rules

1. Display names may be duplicated.
2. Internal identities must be unique.
3. A child Skill identity is based on its normalized `relative_path`; if no relative path exists, AI SkillHub falls back to `source / folder / name`.
4. Router hub Skills are excluded from child-name conflict detection.
5. Author repositories are never modified to solve conflicts.

## Router Rules

Parent/router Skills are generated only under:

`%LOCALAPPDATA%\AI SkillHub\UserData\sources\AI-SkillHub-local-routers`

Generated router Skills use:

- `[ROUTER-HUB]` for the parent collection entry
- `[CHILD-SKILL]` for listed children

GitHub pull/update operations may update original sources, but must not overwrite user conflict choices because those choices are stored in AI SkillHub SQLite metadata.

## Automatic Assignment Rules

When two or more non-router child Skills share the same normalized name, AI
SkillHub automatically assigns the canonical slash route. Candidates are sorted
by:

1. enabled state
2. health status
3. personal rating
4. shortest/directest source path
5. stable source/path ordering as the final tie breaker

Every candidate also receives a source-qualified alias, so automatic assignment
never makes another source uncallable.

The user can set a manual override or restore automatic assignment. If a manual
default disappears after an update, the conflict returns to automatic
assignment instead of becoming unusable.

## Product Behavior

Routing Observatory belongs in the Skill Library management path, not in hidden
logs. Automatic results must be visible, reversible, and persistent.

Slash-command dispatch reads this table indirectly through generated local
dispatchers:

`skill_conflict_choices`

AI SkillHub always generates a local dispatcher Skill for an automatic or manual
default under
`%LOCALAPPDATA%\AI SkillHub\UserData\sources\AI-SkillHub-local-routers\<conflict-name>\SKILL.md`.
That generated Skill uses `[CONFLICT-DISPATCHER]`, points to the selected
source's real `SKILL.md`, and is then synced to the managed Agent skills
directory.

Therefore `/figure-planner` can route to the user's default, while fully qualified
source-qualified aliases such as `/nature-paper-skills-figure-planner` and
`/paperspine-figure-planner` remain callable. Restoring automatic assignment
regenerates the dispatcher from the current health/rating priority.
