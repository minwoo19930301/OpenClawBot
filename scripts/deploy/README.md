# OCI production deployment

Target: the existing A1 server at https://168.107.91.96/.

`CI` runs build, tests, typecheck and deployment-boundary tests. A successful
push to `main` (or manual CI dispatch on `main`) deploys the tested full SHA
when repository variable `OCI_DEPLOY_READY` is `true`. Pull requests never
receive deployment credentials. Production jobs serialize without cancelling
an active rollout. Superseded SHAs are rejected by the host.

GitHub holds `OCI_DEPLOY_SSH_KEY` in its encrypted secret store. The matching
authorized key is restricted to the root-owned `openclaw-release` command:
no interactive shell, forwarding, agent forwarding or arbitrary commands.
`OCI_KNOWN_HOSTS` pins the existing server host key. The OCI administrator API
key stays in the operator's local credential store.

The host validates current `main` against the fixed repository, downloads an
immutable source archive, rejects archive traversal/links, builds before
replacement, backs up SQLite using its backup API, and keeps `:previous` image
tags. It preserves server-only environment files, the application data volume,
and personal Telegram/OpenClaw services.
Current and previous release tags are retained; older generated SHA tags are
retired after success. Operator backup tags and unrelated images are untouched.
Failed rollout/health checks restore
the previous app and desktop images/config. Public HTTPS verification also
checks the expected release and the served frontend assets.

The shared desktop uses a 512 MiB local loop filesystem at
`/var/lib/community-shared/home.ext4`, automatically mounted via `/etc/fstab`.
It is an ordinary file on the existing VM disk, not a new OCI volume. Every
authorized room connects to this one computer; Browser, Files and Terminal
use separate X displays. No VNC/CDP public ports or browser sandbox exceptions
are added. Desktop images rebuild only when their source changes. App-only
releases leave the desktop running.

`OCI deployment setup` is a one-time manual bootstrap workflow. `inspect`
prints only non-secret service metadata. `install` installs the validated
command, the restricted public key (`OCI_DEPLOY_PUBLIC_KEY`) and storage.
`OCI_BOOTSTRAP_SSH_KEY` is removed after successful setup; the setup workflow
cannot connect without it. To repair the deployment command, temporarily
restore that credential through an authorized operator session.

Stop future automatic deployments by setting `OCI_DEPLOY_READY=false`.
Workflow failures are visible in GitHub Actions. A public health check alone
does not verify model replies or authenticated desktop rendering; validate
these when those features change. The host verifies actual RFB handshakes for
all three views on each deployment.

Verified on 2026-10-06: the first rollout restored the previous release when
its desktop handshake failed. After fixing tmpfs migration and profile ownership,
all three RFB handshakes, Google Chrome startup and the public HTTPS release
check passed. CI also verifies that the deployment credential rejects an
arbitrary `id` command before allowing a release request.
