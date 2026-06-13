# AI SkillHub Skill Conflict Selector

This document is the stable product rule for duplicate child Skill names.

## Problem

Different GitHub sources can legitimately contain child Skills with the same `name`.
For example:

- `Nature-Paper-Skills / figure-planner`
- `PaperSpine / figure-planner`

AI SkillHub must not delete, rename, overwrite, or silently choose one of them.

## Identity Rules

1. Display names may be duplicated.
2. Internal identities must be unique.
3. A child Skill identity is based on its normalized `relative_path`; if no relative path exists, AI SkillHub falls back to `source / folder / name`.
4. Router hub Skills are excluded from child-name conflict detection.
5. Author repositories are never modified to solve conflicts.

## Router Rules

Parent/router Skills are generated only under:

`app-next/data/github_sources/AI-SkillHub-local-routers`

Generated router Skills use:

- `[ROUTER-HUB]` for the parent collection entry
- `[CHILD-SKILL]` for listed children

GitHub pull/update operations may update original sources, but must not overwrite user conflict choices because those choices are stored in AI SkillHub SQLite metadata.

## User Choice Rules

When two or more non-router child Skills share the same normalized name, AI SkillHub shows a conflict selector.

The user can:

- set one candidate as the default
- reset the conflict to unresolved
- ignore the reminder while keeping all candidates

If a previously selected default disappears after an update, the conflict returns to unresolved.

## Product Behavior

The conflict selector belongs in the Skill Library management path, not in hidden logs.
It must be visible, reversible, and persistent.

Future slash-command dispatch should read this table:

`skill_conflict_choices`

so `/figure-planner` can route to the user's default, while fully qualified identities such as `Nature-Paper-Skills:figure-planner` and `PaperSpine:figure-planner` remain distinguishable.
