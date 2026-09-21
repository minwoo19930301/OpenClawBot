# Operating procedures

## Release and rollback

1. Read current Git status, live release and the services relevant to the change. Check `apps/community/deploy/README.md` for the current paths. Do not select a similarly named server solely from a note.
2. Make the smallest app/config change. Run the affected tests and the repository CI checks. Use `COMMUNITY_RELEASE` with the full commit SHA when building the app image.
3. Before replacing services, retain the currently running image and back up SQLite using SQLite's backup API when data/schema is affected. A raw copy of a live SQLite database may miss WAL contents. Keep backups private and preserve the existing environment files.
4. Transfer tracked source with `git archive`; do not transfer a whole working directory containing secrets. Build the required service and use Compose `up -d --no-deps --no-build --wait <service>`. Do not use `down -v`.
5. Verify the real HTTPS URL, `/api/health` SHA and representative changed behavior. A successful image build is not a successful deployment. Restore the previous image/config if startup or essential functionality fails; don't keep repeating a failing rollout.

## AI: process running but no reply

- Check whether the message included selected `botIds`. The UI previously defaulted to `[]`, storing human messages without invoking any model. Configured sessions now select the first bot by default; explicit opt-out should remain off during room navigation/refresh.
- Distinguish an existing credential from the active model provider. The application prefers the configured dedicated OpenClaw gateway. An `OPENROUTER_API_KEY` can exist while the selected model is Groq. Read active provider/model metadata before changing it.
- Trace actual room submission → background job → gateway/provider → persisted bot response. Do not log authorization headers, prompts, room contents or complete environment values for diagnosis. Provider status/error categories are usually enough.
- Community adapters wrap plain final text in the upstream runner's `SendMessage` envelope. Do not forward the runner's pseudo-tool formatting prompt to a provider alongside real browser function tools; this produced malformed tool arguments in a live Groq call. Keep plain-text instructions at the community boundary and preserve the adapters' envelope normalization.
- Browser tool calls require a configured room desktop and have action, timeout and model-call quotas. Preserve the additional-call quota check. Test both ordinary chat and a public-page browser task after changing prompts or providers.
- A provider rate-limit failure is not necessarily a context-window failure. A prior Groq 413 was caused by TPM limits. Keep tools/prompts bounded and report the actual category; do not silently enable a paid fallback.

## Remote Linux and Chrome

- The desktop uses Xvfb/Openbox, Google Chrome, x11vnc and websockify. Inspect the Dockerfile and entrypoint for the current ports rather than exposing a raw VNC/CDP port.
- On A1 use the official ARM64 Google Chrome `.deb`. Check package architecture and `google-chrome --version`; record the image digest/version because a `current` download changes on a fresh build.
- Check sandboxed startup with the existing narrow seccomp profile and non-root user. Verify a real Chrome window, CDP page navigation and VNC handshake, then the authenticated app proxy when that path changed.
- Keep browser egress blocked from metadata/link-local/private networks and host management. The host's dedicated firewall/bridge sysctl/service are not automatically installed by Docker Compose.
- Node's fetch may rewrite a custom Host header for Chrome discovery. Use the application's bounded `readCdpVersion` helper, which sends the expected localhost Host header, rather than an unbounded ad hoc fetch.

## Domain and HTTPS migration

1. Resolve the DNS owner and inspect existing records before mutation. A Pages account association alone does not prove access to the authoritative DNS zone. Preserve unrelated apex/MX/TXT records and existing sites.
2. Prepare the chosen hostname, A record target, Caddy host block and rollback. For direct Caddy ACME, a DNS-only A record is a simple option; if proxying through Cloudflare, verify end-to-end TLS and WebSockets and avoid changing zone-wide TLS/cache policies for this app.
3. Provision/verify the hostname certificate before changing `COMMUNITY_ORIGIN`. Caddy's certificate must validate without disabling TLS checks.
4. Update only the application's canonical origin and relevant public links/push contact URL; preserve the VAPID key pair. Redirect the old IP URL to the new hostname after the new route works. Keep strict Origin/CSRF checks, and never add a wildcard trusted origin to make both sites work.
5. Existing accounts/messages remain in the same volume. Cookies, service workers, notification permissions and push subscriptions are origin-specific. Users log in and enable notifications again on the new hostname; do not copy cookies or browser credentials between origins.
6. Verify DNS resolution, HTTPS `/api/health`, manifest/SW, Origin rejection for the old/foreign origin, and authenticated desktop WebSocket behavior as relevant. Do not claim mobile push delivery solely because the server accepted a test send.

## PWA/Web Push

- Use one stable HTTPS hostname for installation. The manifest name is OpenClawBot; keep app id/start URL/scope deliberate when migrating.
- On supported iOS/iPadOS, users add the site to the Home Screen and launch that app before enabling push. Other browser installation and permission flows differ. Consult current vendor documentation when giving platform-specific instructions.
- Notification permission requires a user's gesture. Use the app's enable/test controls, and distinguish provider acceptance from an actual OS notification. A browser's denied permission cannot be silently re-enabled by the app.
- Never cache authentication, chat APIs or private media in the service worker. Push content stays generic, delivery is checked against current room/session permissions, and logout removes that session's subscription.

## Useful primary references

- Google Chrome supported platforms: https://support.google.com/chrome/answer/95346
- Cloudflare DNS API: https://developers.cloudflare.com/api/resources/dns/
- Caddy automatic HTTPS: https://caddyserver.com/docs/automatic-https
- Apple Web Push: https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
