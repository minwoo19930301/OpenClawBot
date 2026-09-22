# OpenClawBot Singapore Docker deployment

Live deployment: [https://168.107.91.96](https://168.107.91.96), Oracle Linux 9 ARM64 on the existing 4 OCPU / 24 GB host. No new OCI instance, volume, or load balancer is required by this change. OCI free allowances and model provider billing must be checked against the account's actual usage; the deployment does not enforce a zero-dollar billing cap.

The OpenClawBot app, shared Linux desktop, Caddy, and optional OpenClaw gateway run in separate containers. The website gateway has its own state volume, workspace, authentication token, and private Docker network. It has no Telegram channel, personal OpenClaw state, host home directory, Docker socket, or host file mount. The host's pre-existing personal OpenClaw service remains separate.

## Services

- Public site: `https://168.107.91.96`. Caddy requests and automatically renews a Let's Encrypt `shortlived` IP certificate. Only ports 80/443 are published to the Internet.
- App: Node 24, SQLite and media in the `community_community-data` Docker volume; loopback port 8787 for local diagnostics.
- OpenClaw: pinned official `ghcr.io/openclaw/openclaw:2026.9.5` image, optional `openclaw` Compose profile, private service `openclaw:18890`, no published gateway port. `tools.deny: ["*"]` disables built-in tools; the application executes only its validated room browser client tools. The example uses the operator's configured Groq model, without enabling other providers or automatic paid fallbacks.
- Room computer: Debian, Xvfb, Openbox, Google Chrome with its sandbox enabled. The multi-architecture image downloads the official Google Chrome `.deb` for `amd64` or `arm64`; the ARM64 candidate was verified with Google Chrome `153.0.8010.52`, including sandboxed startup, page navigation, screenshot capture and the VNC handshake. noVNC traffic is proxied through the app with login, room membership, Origin checks and a single-use 60-second ticket. Host-published VNC/CDP ports bind to host loopback; the app container reaches the mapped desktop through the dedicated `community-desktop` network using the desktop service hostname and internal ports.
- A room maps to its own desktop container. The provisioned initial room is `4bc4b8f0-1789-4afb-a927-e7adbcc7b9b9`. Newly created chat rooms have no computer until an operator provisions a distinct container and adds it to the server-side mapping. A computer may not be shared by unrelated rooms.
- Shared desktop storage is temporary (512 MB RAM filesystem); browser login state and downloads disappear when its container is recreated. All members of that room can see and control the same computer.

## Boot and configuration

From the repository root, build the app and desktop images before the first start (or after changing either image): `docker compose -f apps/community/deploy/compose.yml build`. The browser bundle is built with esbuild from unmodified noVNC 1.7.0, with license notices retained.

`apps/community/deploy/.env.production` is a mode-0600 server-only file, excluded from Git and Docker build context. It holds the public origin, bootstrap invite and optional dedicated model configuration. `.env.openclaw` is a separate mode-0600 server-only credential store for the gateway token and provider key. Do not print these files or copy them into support logs. The model provider key is not required in the web app container.

Optional Web Push uses `COMMUNITY_PUSH_SUBJECT`, `COMMUNITY_PUSH_PUBLIC_KEY`, and `COMMUNITY_PUSH_PRIVATE_KEY` in `.env.production`. Keep the VAPID private key server-only; never place it in the browser bundle, Compose file, logs, or a public issue. Leave all three empty to disable push. Subscription endpoints and encryption keys are stored in the application SQLite volume and are removed for the logging-out session or when the push service reports them expired.

The first account created with the bootstrap invitation becomes the administrator and owns the initial shared room. Later accounts need single-use, 24-hour site invitations; room membership separately requires a room invitation. Passwords are individually salted/scrypt hashed, and session cookies are HttpOnly/Secure/SameSite=Strict.

Before admitting users, install and enable the scoped desktop egress firewall, Docker forwarding drop-in, and bridge sysctl described in `desktop/README.md`; these host files are not installed by Compose. Google Chrome sandbox requirements and any narrow seccomp additions are documented there. Never use `--no-sandbox`, privileged containers, host filesystem mounts or the Docker socket in the shared desktop.

Start services from this directory with `docker compose up -d --no-build`. Restart policies bring them back after Docker/host restart. Never run `docker compose down -v` unless intentionally deleting the site database, uploads, and certificate data.

For OpenClaw, put `COMMUNITY_OPENCLAW_BASE_URL=http://openclaw:18890`, `COMMUNITY_OPENCLAW_AGENT_ID=community`, `COMMUNITY_OPENCLAW_ALLOW_PRIVATE_HTTP=1` and a private `COMMUNITY_OPENCLAW_TOKEN` in `.env.production`. Put the same token and `GROQ_API_KEY` in `.env.openclaw`; [openclaw/.env.example](openclaw/.env.example) lists names only. Start with `docker compose --profile openclaw up -d --no-build`. `openclaw/community.json` contains only environment references. Never connect the website adapter to a personal gateway with unrestricted built-in tools.

Set `COMMUNITY_RELEASE` to the source commit when building, for example `COMMUNITY_RELEASE=$(git rev-parse HEAD) docker compose build app`; confirm `/api/health` reports the same revision after deploying. Back up SQLite with the `node:sqlite` backup API before each release. To roll back, restore the prior app image/configuration while preserving the data volumes.

The checked-in Compose, Caddy and firewall files describe this deployment's public IP and one initial room. For another host, replace the public IP, network ranges and room UUID together and provision independent desktops for other rooms. Neither the room UUID nor public IP is an authentication credential.

The optional local `scripts/setup-admin.mjs` helper reads the bootstrap invite through authorized SSH and presents a 30-minute loopback form. Set `COMMUNITY_SETUP_SITE`, `COMMUNITY_SETUP_SSH_HOST`, `COMMUNITY_SETUP_SSH_KEY`, and `COMMUNITY_SETUP_REMOTE_ENV` using your own deployment metadata. The user enters their new password directly; the helper never logs it or the invite.

## Model and media behavior

OpenClaw takes priority when `COMMUNITY_OPENCLAW_BASE_URL` and `COMMUNITY_OPENCLAW_TOKEN` are configured. Otherwise, all three direct-provider variables `COMMUNITY_LLM_BASE_URL`, `COMMUNITY_LLM_API_KEY`, `COMMUNITY_LLM_MODEL` are required. Without either backend, human chat and remote desktop work, and bot calls are explicitly disabled. Production never enables `COMMUNITY_DEMO`.

When configured, selected bots can use the room's browser via bounded navigate/snapshot/click/type/key/scroll tools. Each bot turn has at most four browser actions and five provider calls. Additional calls count against the same per-user/global daily quotas (defaults 30/200). Web content is treated as untrusted. Private/metadata destinations are blocked in application checks and in host networking.

PWA installation and Web Push require HTTPS and explicit browser permission. The repository documents the push contract and includes provider endpoint validation, but actual notification delivery through each browser/provider and production push reception still require a live deployment check.

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

## Optional hostname migration (on hold)

The canonical address remains `https://168.107.91.96/` by user choice. DNS migration is on hold; a custom hostname is not required for the existing HTTPS PWA. The optional hostname is `bot.ai-ing.org`. `Caddyfile.domain` is the staged configuration: it serves that hostname and redirects the previous IP URL. Until authoritative DNS access and a valid hostname certificate are verified, the running Compose file keeps `Caddyfile.ip` and the IP origin. Do not switch the application origin merely because this prepared file exists.

Cutover order:

1. Confirm the `ai-ing.org` zone and that `bot` has no conflicting record. Add a DNS-only A record `bot.ai-ing.org` → `168.107.91.96`.
2. Serve the hostname alongside the current IP with Caddy and verify a publicly trusted certificate.
3. Back up the server-only environment, set `COMMUNITY_ORIGIN=https://bot.ai-ing.org`, update `COMMUNITY_PUSH_SUBJECT` to the hostname URL without rotating VAPID keys, and recreate only the app.
4. Switch the Caddy bind mount to `Caddyfile.domain` and restart Caddy. Confirm the IP redirect and hostname HTTPS health, then update public documentation and GitHub homepage links.
5. Sign in again on the hostname. Install the PWA there and enable/test notifications on each user's device; IP-origin login cookies and push subscriptions do not transfer.

The reusable operating skill is [oci-openclaw-ops](../../../.agents/skills/oci-openclaw-ops/SKILL.md). Copy that folder to your agent's skills directory if desired. Its public checker accepts an explicit HTTPS origin and optional expected release SHA.

## 서버 전체 자원 제한과 관리자 모니터링

운영 호스트는 systemd/cgroup v2를 사용합니다. Compose의 모든 서비스는 `community.slice` 아래에서 **합계 CPU 3개·RAM 16GiB**, swap 0으로 제한됩니다. 개별 컨테이너 제한도 함께 적용됩니다. 별도 개인 OpenClaw 서비스는 CPU 0.5개·RAM 2GiB로 제한해 OS 여유를 남깁니다. 새 OCI VM·디스크·유료 API fallback을 자동 생성하지 않습니다. 이 제한은 **OCI 무료 한도나 청구 차단 기능이 아닙니다**.

운영자가 `monitor/community.slice`를 `/etc/systemd/system/`에 설치하고 daemon-reload/start한 뒤 Compose를 실행해야 합니다. 기존 컨테이너의 parent 변경에는 recreate가 필요합니다. `monitor/collect.py`는 `/usr/local/lib/community-monitor/collect.py`에 설치하고 `/var/lib/community-monitor`를 생성한 뒤 동봉한 service/timer를 활성화합니다. 개인 서비스에는 `systemctl set-property openclaw.service CPUQuota=50% MemoryMax=2G MemorySwapMax=0`을 적용합니다. 기존 사양과 볼륨은 유지합니다.

수집기는 매분 호스트 RAM·디스크·실제 cgroup 제한을 읽어 원자적으로 JSON을 교체합니다. 웹앱에는 이 디렉터리만 읽기 전용으로 전달하며 **Docker socket이나 호스트 실행 권한을 전달하지 않습니다**. `COMMUNITY_MONITOR_PATH` 설정 시 관리자에게만 **서버 모니터링** 방이 생깁니다. 이 방은 초대할 수 없고, 질문에는 현재 수치를 규칙 기반으로 설명하며 모델 API를 호출하지 않습니다. 상태 전환(수집 중단·제한 확인 실패·디스크 85%·커뮤니티 RAM 85%)에만 메시지와 기존 PWA 경로로 알림을 발행합니다. 데이터가 3분 이상 오래되면 확인 불가로 표시합니다. 실제 OS 알림은 사용자 권한·기기 수신 확인이 필요합니다.

디스크는 경고이며 파일시스템 전체 하드 쿼터가 아닙니다. 첨부파일은 기존 앱 저장량 제한, 컨테이너 로그는 회전 제한을 따릅니다. OCI 비용 데이터는 아직 이 수집기에 연결되지 않았으므로 청구액을 0원이라고 추정하지 않습니다. 대화별 데스크톱 자동 생성/유휴 정지는 별도 구현 대상이며 현재는 기존 방 매핑을 유지합니다.


## 대화별 데스크톱 자동 생성

> 이 기능은 배포 준비 중입니다. 실제 운영 반영 및 두 방 분리 검증 전까지 기존 사이트의 자동 생성 완료를 의미하지 않습니다.

`COMMUNITY_PROVISIONER_SOCKET`을 설정하면 방을 열 때 인증·방 멤버십·CSRF 확인 후 로컬 Unix socket broker에 생성/시작을 요청합니다. 웹앱에는 Docker socket을 전달하지 않습니다. broker는 UUID만 받아 고정 이미지·네트워크·권한·상한으로만 실행합니다. `provisioner/community-provisioner.service`와 `provisioner/service.py`를 호스트에 설치해야 하며, 기존 방의 수동 map은 그대로 유지합니다.

- 이미지: 검증된 `community-desktop:local`을 `desktop/Dockerfile.managed`로 확장한 `community-desktop:managed`. 하단 Tint2 독에 Terminal, Google Chrome, Files를 고정합니다.
- 신규 데스크톱 동시 실행 2개(기존 공동 대화 데스크톱 별도), 저장 공간 4개까지. 각 1 CPU·2GiB이고 모두 기존 `community.slice` 합산 제한 안에 들어갑니다.
- `/var/lib/community-desktops/<UUID>/home.ext4`의 512MiB 고정 파일시스템에 Chrome 프로필과 파일을 저장합니다. 호스트 여유 공간이 3GiB 미만이면 새 공간 생성을 거절합니다. 파일 삭제·추가 디스크 구매는 자동으로 하지 않습니다.
- 연결된 화면은 짧은 lease를 갱신합니다. 화면 연결 종료/백그라운드 탭 전환 후 15분 동안 재연결하지 않으면 컨테이너를 정지합니다. 프로필/파일은 유지하지만 실행 중인 프로세스·미저장 편집 내용은 유지되지 않습니다.
- IP `.4`–`.7`을 할당하며 desktop subnet 전체에서 앱 주소 `.2`를 제외한 egress를 host nft guard로 보호합니다. private/metadata/host 접근 및 데스크톱 간 신규 연결을 차단합니다. 기존 guard를 먼저 업데이트해야 하며 broker는 설정을 확인하지 못하면 생성하지 않습니다.
- broker/호스트 재시작 시 managed 컨테이너를 정지하고, 다음 ensure에서 파일시스템 remount 후 시작합니다. 관리자 모니터링 방은 생성 대상이 아닙니다.

검증: `python3 apps/community/deploy/provisioner/test_service.py` 및 community 테스트. 배포 순서: guard 업데이트 → managed 이미지 build → broker 설치/start → app build/recreate → 실제 두 방의 VNC/CDP·파일 분리·재시작 보존 확인. 아직 동시 실행 한도에 대기열 자동 예약 기능은 없으므로 안내를 보고 다시 열어야 합니다.
