---
name: oci-openclaw-ops
description: Operate and customize OpenClawBot on OCI Ampere A1 with Docker, a dedicated OpenClaw gateway, remote Linux Google Chrome, DNS/HTTPS, and PWA notifications. Use for this deployment's upgrades, diagnostics, domain moves, and reusable operating procedures.
---

# OCI OpenClawBot operations

Keep the existing deployment usable while applying the requested customization. This skill records the tested architecture; it does not authorize new OCI resources, billing changes, provider switches, or credential sharing.

## Establish the target

- Locate the user-selected checkout and inspect its Git remote. For a fork, use the operator's own repository and private deployment configuration; no repository owner or server target is built in. Preserve the upstream remote, attribution and GPL license.
- Inspect the portable templates and the operator-selected private configuration. Automated releases use `/etc/openclaw/deployment.json` and `/etc/openclaw/compose.yml`; see `scripts/deploy/README.md`. Verify the configured origin against its live `/api/health` release. Treat old reports as leads, not current-state proof.
- Use existing SSH and DNS credentials without printing values. Read only relevant configuration and report provider/model names or credential presence, not secret contents.
- Keep the user's established VM sizing unless the request changes it. A1 region capacity, subscription limits and free allowances are separate questions; check the actual tenancy and current Oracle terms before claiming a change is free. Do not downgrade, upgrade PAYG or create a replacement VM merely to troubleshoot the application.

## Operating boundaries

- Keep application authentication and data separate from unrelated services. When using OpenClaw, use a dedicated gateway and state volume. Personal service history and private agent workspaces must not be inherited by community members.
- The shared desktop is a Linux GUI container inside the VM, not a host administration console. Use the official Google Chrome package matching the CPU architecture. Verify the installed binary, sandbox and live desktop; a Chromium binary is not evidence of Google Chrome.
- Keep VNC/CDP behind the authenticated room proxy, preserve room membership checks, short-lived tickets, the desktop egress firewall, non-root execution and the browser sandbox. Never solve a Chrome startup failure with `--no-sandbox` or privileged Docker.
- The operator configures a shared workspace or individual room mappings. Creating a new chat does not create a VM/container automatically. Preserve existing mounts and data; profile/file persistence follows the operator's volume configuration.
- Model credentials, OpenClaw tokens, invitation codes, VAPID private keys and push subscription keys stay in the operator's server-side environment files or private vault. Use an explicit `COMMUNITY_INTEGRATIONS_FILE` for service connections. Never archive secrets, databases, user attachments or private context into Git or the Docker build context.

## Choose the relevant procedure

Read [operations.md](references/operations.md) for release/rollback, AI diagnosis, Chrome verification, or DNS/PWA migration.

For public deployment validation, run:

```sh
node <skill-directory>/scripts/check-public.mjs https://<site-host> <expected-git-sha>
```

The check verifies public HTTPS, release identity, OpenClaw configuration, the PWA manifest and service worker. It does not prove successful model replies, authenticated desktop control, or delivery of an OS notification; validate those separately when affected by the change.

## Finish with evidence

State which release and operator-configured URL are live, what actually passed, and what remains dependent on the user's device or account access. A healthy process or connection label is not a successful chat response. Report limitations from the current code and configuration, and verify model/media/workspace features affected by a change.
