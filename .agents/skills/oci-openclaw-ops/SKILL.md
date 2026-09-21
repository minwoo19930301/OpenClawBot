---
name: oci-openclaw-ops
description: Operate and customize OpenClawBot on OCI Ampere A1 with Docker, a dedicated OpenClaw gateway, remote Linux Google Chrome, DNS/HTTPS, and PWA notifications. Use for this deployment's upgrades, diagnostics, domain moves, and reusable operating procedures.
---

# OCI OpenClawBot operations

Keep the existing deployment usable while applying the requested customization. This skill records the tested architecture; it does not authorize new OCI resources, billing changes, provider switches, or credential sharing.

## Establish the target

- Locate the repository via its Git remote, currently `minwoo19930301/OpenClawBot`; a local checkout can still be named `open-grokbot`. Preserve the upstream remote, attribution and GPL license. GitHub renaming does not detach a fork.
- Inspect `apps/community/deploy/compose.yml`, the active Caddy configuration and the live `/api/health` release. Treat old reports as leads, not current-state proof.
- Use existing SSH and DNS credentials without printing values. Read only relevant configuration and report provider/model names or credential presence, not secret contents.
- Keep the user's established VM sizing unless the request changes it. A1 region capacity, subscription limits and free allowances are separate questions; check the actual tenancy and current Oracle terms before claiming a change is free. Do not downgrade, upgrade PAYG or create a replacement VM merely to troubleshoot the application.

## Operating boundaries

- The website uses its own OpenClaw gateway, state volume and authentication. The personal Telegram service is separate. Reuse neither its history nor its complete private workspace for community members.
- The shared desktop is a Linux GUI container inside the VM, not a host administration console. Use the official Google Chrome package matching the CPU architecture. Verify the installed binary, sandbox and live desktop; a Chromium binary is not evidence of Google Chrome.
- Keep VNC/CDP behind the authenticated room proxy, preserve room membership checks, short-lived tickets, the desktop egress firewall, non-root execution and the browser sandbox. Never solve a Chrome startup failure with `--no-sandbox` or privileged Docker.
- A desktop is provisioned per mapped room. Creating a new chat room does not create a VM/container automatically. Desktop profiles/downloads are ephemeral; accounts, messages and attachments live in the persistent application volume.
- Model credentials, OpenClaw tokens, invitation codes, VAPID private keys and push subscription keys stay in existing server-side stores. Never archive `.env*` secrets, databases or user attachments into Git or the Docker build context.

## Choose the relevant procedure

Read [operations.md](references/operations.md) for release/rollback, AI diagnosis, Chrome verification, or DNS/PWA migration.

For public deployment validation, run:

```sh
node <skill-directory>/scripts/check-public.mjs https://<site-host> <expected-git-sha>
```

The check verifies public HTTPS, release identity, OpenClaw configuration, the PWA manifest and service worker. It does not prove successful model replies, authenticated desktop control, or delivery of an OS notification; validate those separately when affected by the change.

## Finish with evidence

State which release and URL are live, what actually passed, and what remains dependent on the user's device or account access. A healthy process or “OpenClaw connected” label is not a successful chat response. Preserve concrete limitations such as no image recognition/audio transcription and manual provisioning for new room desktops.
