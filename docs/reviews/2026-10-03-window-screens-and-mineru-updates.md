# Window screenshots and MinerU update repair

The GitHub homepage now opens in Simplified Chinese, with complete English and Korean counterparts.

## Screenshot evidence

Three English screenshots use the current application UI and an isolated demonstration library:

| View | State | Output |
| --- | --- | --- |
| Sky noon islands | Normal window layout | 4320 × 2880 PNG |
| Midnight star map | Normal window layout | 4320 × 2880 PNG |
| Relations graph | Application immersive toggle enabled | 4320 × 2880 PNG |

The layout viewport is 1440 × 960 at device scale 3. Browser/OS fullscreen remains off. These are Playwright-rendered application contents, without a native window frame; they are not whole-desktop captures. Checks found no Chinese UI text, toast overlays, or page errors. Images were visually inspected.

## MinerU: two independent update mechanisms

The manually imported `mineru-document-extractor` Skill had no Git metadata or upstream URL. Its original `SKILL.md` matches the official `opendatalab/MinerU-Ecosystem` Git blob exactly (`ffb26c4448e5ed3e6b4ef48d37e00e1bd2ba4402`). The other two package files match after normalizing Windows checkout line endings.

The local source was converted to a sparse Git checkout of the official repository's `skills` directory. The existing source folder, source identity, parent invocation name and category membership were retained. The parent router now resolves the author's `skills/SKILL.md`. The working tree is clean, and the upstream URL is indexed. Subsequent source updates can follow the existing Git update path. Local edits or a pinned revision will still deliberately prevent an unsafe overwrite.

Separately, the Codex MinerU MCP launch argument changed from `mineru-open-mcp` to `mineru-open-mcp@latest`, following [uv's documented latest-version behavior](https://docs.astral.sh/uv/guides/tools/). The launcher path, environment-variable credential declaration and all other configuration values were preserved. The latest resolved distribution is `mineru-open-mcp` 1.0.22. MCP initialization and `tools/list` succeeded, listing `parse_documents` and `get_ocr_languages`. No document upload or tool execution was performed. An already-running MCP process needs to restart to use the new launch argument.

## Validation and recovery

- Original Skill files, SQLite, app configuration and parent router were backed up before migration; the MCP configuration was backed up separately.
- A full isolated executable copy, user profile and data root verified the nested Skill layout and generated parent router before modifying the real source.
- Migration used a staged directory swap and rollback on failure. The temporary previous-directory record was removed by a final native index refresh after moving the original out of the scanned sources directory.
- Final native indexing contains exactly one MinerU source and the original source identity/category membership. Its parent router resolves an existing official Skill file.
- No application code or release version changed. Public application release remains v3.2.15.

Sources: [MinerU official ecosystem](https://github.com/opendatalab/MinerU-Ecosystem), [uv tools documentation](https://docs.astral.sh/uv/guides/tools/).
