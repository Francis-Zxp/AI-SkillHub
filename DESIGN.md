# SkillHub Design Notes

## Visual Direction

Quiet desktop utility for research workflow management. The UI should feel reliable, clear, and precise rather than flashy.

## Color

Use a restrained palette:

- Warm off-white surface instead of pure white.
- Ink-tinted text instead of pure black.
- Blue-green accent for healthy/synced state.
- Amber for warnings.
- Red for failures.
- Muted blue for actions.

## Components

- Status banner at the top with a visible success/failure state.
- Repository input area with URL, type, and action buttons.
- Active Skills table with name, source repository, and target status.
- Log panel for readable output after an action.
- Buttons should use clear verbs: Sync Now, Add Repository, Install Auto Update, Open Report.

## Interaction

- Every long action changes the status to "Running".
- Success shows a green status and summary count.
- Failure shows a red status and the most useful error lines.
- Refresh the active Skill list after sync.
- Never make users inspect PowerShell output to know whether something worked.
