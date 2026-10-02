# Bundled UI font

AI SkillHub bundles **SkillHub Sans UI**, a UI subset derived from Noto Sans SC by Adobe / Google. It unifies Simplified Chinese and Latin text without installing fonts into Windows or fetching fonts while the app runs.

- Official source: [Google Fonts Noto Sans SC](https://github.com/google/fonts/tree/main/ofl/notosanssc).
- Original download: `https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf` (retrieved 2026-10-02).
- Source SHA-256: `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`.
- License: SIL Open Font License 1.1. The original copyright and full license ship at `public/fonts/OFL-NotoSansSC.txt`.
- Modified family name: `SkillHub Sans UI`; the reserved name “Source” is not used for the derivative.
- Local asset: `public/fonts/skillhub-sans-ui.woff2`, 1,972,164 bytes, SHA-256 `1bf1809abc7f9b755e9ffd44c0ec48cf7687e6a5c9566b50edb811c19dc76722`.
- Coverage: GB2312, all characters present in the application's TS/TSX/CSS at generation, Latin U+0020–02FF and Chinese/fullwidth punctuation; 8,515 glyphs. Uncommon user-provided characters and Korean use the platform fallback stack rather than missing-glyph boxes.
- Variable weight range: 400–700. The UI uses real Regular / Medium / Semibold / Bold interpolation and disables synthetic styling.

The subset was generated using fontTools: collect the Unicode set above, subset the original font while retaining OpenType layout, instantiate the variable weight axis to 400–700, rename family/name records to SkillHub Sans UI and encode as WOFF2. Retain the OFL text when rebuilding or distributing the asset. Source font and intermediate tooling stay in ignored development reports and do not ship.

Validation checks actual Chromium font selection through `CSS.getPlatformFontsForNode`, successful local font loading, responsive text layout, and desktop/4K screenshots. This confirms the bundled font is rendering, rather than just appearing in a CSS font stack.
