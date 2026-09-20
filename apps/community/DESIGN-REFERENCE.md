# UI reference — 2026-09-20

The initial Bot Lounge branding, navy/blue palette, large room heading, promotional login panel and decorative copy were removed at the user's request. The UI now follows the neutral dark desktop chat layout documented by the public Grok Bot 0.18 reconstruction.

## Evidence used

- Repository: https://github.com/b-nnett/grok-bot-0.18-reconstructed
- Public reference capture: `docs/assets/router-settings.png` (reconstructed Router settings over its retained chat shell; not a standalone original main-chat screenshot).
- `frontend/src/recovered/features/runtime-theme-token-installer.ts`: monochrome Sand palette, system font, 13px base text, 11px metadata, 8/18px radii; bubble colors `#262626` and `#5a5a5a`.
- `frontend/src/recovered/features/conversation/workspace/sidebar-layout-state.ts`: 280px default sidebar.
- `frontend/src/recovered/features/conversation/workspace/view.css`: 58px sidebar rows, 34px avatars, 51px chat header, 690px transcript and 700px composer width rules.
- `frontend/src/production/production.css`: account controls at the bottom of the sidebar, subdued search field.

This is a web adaptation of the public reconstructed UI, not the full shipped Electron renderer or a claim of pixel-perfect reproduction. The original repository explicitly distinguishes its partial frontend reconstruction from the pinned shipped renderer. No original app binaries, account integration, telemetry, or proprietary icon font are loaded by this web app.

## Web adaptation

The shared-room API, invitation signup, per-member permissions and model limits remain connected to the existing backend. Own messages use the authenticated user's server-provided `authorId` for right alignment. Search filters the user's rooms locally; the selected room is remembered per account in the browser session. Mobile navigation opens as a drawer. Missing product features are not represented by inactive controls.
