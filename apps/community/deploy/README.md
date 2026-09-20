# Singapore Docker deployment

Live deployment: [https://168.107.91.96](https://168.107.91.96), Oracle Linux 9 ARM64 on the existing 4 OCPU / 24 GB host. No new OCI instance, volume, or load balancer is required by this change. OCI free allowances and model provider billing must be checked against the account's actual usage; the deployment does not enforce a zero-dollar billing cap.

The app, shared Linux desktop, Caddy, and optional OpenClaw gateway run in separate containers. The website gateway has its own state volume, workspace, authentication token, and private Docker network. It has no Telegram channel, personal OpenClaw state, host home directory, Docker socket, or host file mount. The host's pre-existing personal OpenClaw service remains separate.

## Services

- Public site: `https://168.107.91.96`. Caddy requests and automatically renews a Let's Encrypt `shortlived` IP certificate. Only ports 80/443 are published to the Internet.
- App: Node 24, SQLite and media in the `community_community-data` Docker volume; loopback port 8787 for local diagnostics.
- OpenClaw: pinned official `ghcr.io/openclaw/openclaw:2026.9.5` image, optional `openclaw` Compose profile, private service `openclaw:18890`, no published gateway port. `tools.deny: ["*"]` disables built-in tools; the application executes only its validated room browser client tools. The example uses the operator's configured Groq model, without enabling other providers or automatic paid fallbacks.
- Room computer: Debian, Xvfb, Openbox, Chromium with its sandbox enabled. noVNC traffic is proxied through the app with login, room membership, Origin checks and a single-use 60-second ticket. Host-published VNC/CDP ports bind to host loopback; the app container reaches the mapped desktop through the dedicated `community-desktop` network using the desktop service hostname and internal ports.
- A room maps to its own desktop container. The provisioned initial room is `4bc4b8f0-1789-4afb-a927-e7adbcc7b9b9`. Newly created chat rooms have no computer until an operator provisions a distinct container and adds it to the server-side mapping. A computer may not be shared by unrelated rooms.
- Shared desktop storage is temporary (512 MB RAM filesystem); browser login state and downloads disappear when its container is recreated. All members of that room can see and control the same computer.

## Boot and configuration

From the repository root, build the app and desktop images before the first start (or after changing either image): `docker compose -f apps/community/deploy/compose.yml build`. The browser bundle is built with esbuild from unmodified noVNC 1.7.0, with license notices retained.

`apps/community/deploy/.env.production` is a mode-0600 server-only file, excluded from Git and Docker build context. It holds the public origin, bootstrap invite and optional dedicated model configuration. `.env.openclaw` is a separate mode-0600 server-only credential store for the gateway token and provider key. Do not print these files or copy them into support logs. The model provider key is not required in the web app container.

The first account created with the bootstrap invitation becomes the administrator and owns the initial shared room. Later accounts need single-use, 24-hour site invitations; room membership separately requires a room invitation. Passwords are individually salted/scrypt hashed, and session cookies are HttpOnly/Secure/SameSite=Strict.

Before admitting users, install and enable the scoped desktop egress firewall, Docker forwarding drop-in, and bridge sysctl described in `desktop/README.md`; these host files are not installed by Compose. Chromium sandbox requirements and any narrow seccomp additions are documented there. Never use `--no-sandbox`, privileged containers, host filesystem mounts or the Docker socket in the shared desktop.

Start services from this directory with `docker compose up -d --no-build`. Restart policies bring them back after Docker/host restart. Never run `docker compose down -v` unless intentionally deleting the site database, uploads, and certificate data.

For OpenClaw, put `COMMUNITY_OPENCLAW_BASE_URL=http://openclaw:18890`, `COMMUNITY_OPENCLAW_AGENT_ID=community`, `COMMUNITY_OPENCLAW_ALLOW_PRIVATE_HTTP=1` and a private `COMMUNITY_OPENCLAW_TOKEN` in `.env.production`. Put the same token and `GROQ_API_KEY` in `.env.openclaw`; [openclaw/.env.example](openclaw/.env.example) lists names only. Start with `docker compose --profile openclaw up -d --no-build`. `openclaw/community.json` contains only environment references. Never connect the website adapter to a personal gateway with unrestricted built-in tools.

Set `COMMUNITY_RELEASE` to the source commit when building, for example `COMMUNITY_RELEASE=$(git rev-parse HEAD) docker compose build app`; confirm `/api/health` reports the same revision after deploying. Back up SQLite with the `node:sqlite` backup API before each release. To roll back, restore the prior app image/configuration while preserving the data volumes.

The checked-in Compose, Caddy and firewall files describe this deployment's public IP and one initial room. For another host, replace the public IP, network ranges and room UUID together and provision independent desktops for other rooms. Neither the room UUID nor public IP is an authentication credential.

The optional local `scripts/setup-admin.mjs` helper reads the bootstrap invite through authorized SSH and presents a 30-minute loopback form. Set `COMMUNITY_SETUP_SITE`, `COMMUNITY_SETUP_SSH_HOST`, `COMMUNITY_SETUP_SSH_KEY`, and `COMMUNITY_SETUP_REMOTE_ENV` using your own deployment metadata. The user enters their new password directly; the helper never logs it or the invite.

## Model and media behavior

OpenClaw takes priority when `COMMUNITY_OPENCLAW_BASE_URL` and `COMMUNITY_OPENCLAW_TOKEN` are configured. Otherwise, all three direct-provider variables `COMMUNITY_LLM_BASE_URL`, `COMMUNITY_LLM_API_KEY`, `COMMUNITY_LLM_MODEL` are required. Without either backend, human chat and remote desktop work, and bot calls are explicitly disabled. Production never enables `COMMUNITY_DEMO`.

When configured, selected bots can use the room's browser via bounded navigate/snapshot/click/type/key/scroll tools. Each bot turn has at most four browser actions and five provider calls. Additional calls count against the same per-user/global daily quotas (defaults 30/200). Web content is treated as untrusted. Private/metadata destinations are blocked in application checks and in host networking.

Gateway session keys are scoped to authenticated user, room, bot and a fresh turn nonce. The application supplies the room's bounded shared history. Gateway transcripts are confined to its dedicated volume. This is an invite-only shared application, not a general-purpose hostile multi-tenant code-execution service.

Picture/audio files are limited to 12 MiB each and four per message; account uploads to 100 MiB/day and stored media to 1 GiB. Uploads are MIME/signature checked. Unposted uploads are visible only to their uploader; published files are visible only to room members. Audio supports byte ranges. Voice recording is capped at 120 seconds. Attachments are displayed to people; image interpretation and audio transcription are not implemented by the text-only model adapter.

## Verification and operations

Run `node --test --test-timeout=15000 apps/community/test/*.test.mjs` locally after building the runner. Tests cover authentication, invitations, per-room isolation, rate budgets, media access/ranges/abort cleanup, browser URL/ref handling and authenticated WebSocket proxying. A synthetic provider verifies the browser tool loop without spending provider credits.

Useful read-only checks:

```
curl -f https://168.107.91.96/api/health
docker compose ps
docker stats --no-stream
```

Keep backups of the app data volume and the server-only configuration before releases. An SQLite backup must use SQLite's backup API (or stop only the app while copying its database/WAL together). The deployment adds no access to the existing OpenClaw configuration or personal conversation state.
