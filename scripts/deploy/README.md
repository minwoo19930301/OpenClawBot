# Operator-configured deployment

Forks have **no deployment target**. CI builds and tests on its own, and skips
production deployment until the operator explicitly sets its repository variables
and secret. No server address, GitHub account, room ID, mail account, or API key
is selected by the repository.

## Private host configuration

Prepare `/etc/openclaw` as root-owned and non-writable by other users. Place both
files below there as root:root, mode `0600`; symlink files are rejected.

`/etc/openclaw/deployment.json` has these required fields. Substitute your own
values; the example is not a working configuration:

```json
{
  "repository": "YOUR_ACCOUNT/YOUR_REPOSITORY",
  "checkout_root": "/srv/your-openclaw-checkout",
  "deployment_user": "your_operator",
  "shared_desktop_room": "YOUR_GENERATED_ROOM_UUID",
  "shared_storage_root": "/var/lib/your-openclaw-desktop",
  "public_origin": "https://your-site.example",
  "compose_project": "community",
  "desktop_service": "desktop"
}
```

An optional `run_command_user` grants that existing OS account the same restricted
release command. There is no default OCI Run Command account. Paths must be
absolute without spaces or traversal. The public origin must exactly match
`COMMUNITY_ORIGIN` in the private `.env.production` (a trailing slash is ignored).
Image names are `<compose_project>-app` and `<compose_project>-desktop`.

`/etc/openclaw/compose.yml` is the operator's production Compose manifest. Use the
repository template as a starting point for a new installation. Compose runs with
`--project-directory <checkout_root>/apps/community/deploy` and that directory's
private `.env.production` as interpolation input. Keep API/provider/VAPID/mail
credentials in existing server-only environment files or the private vault; never
copy them into this repository, the source archive, or container build context.

For an **existing installation**, preserve its current Compose manifest, service
names, volume names, networks and images in the private file. Preserve operator
Caddy/OpenClaw JSON files outside the source checkout too, and point the private
manifest's bind mounts at those files. This avoids replacing deployment-specific
settings with the portable repository templates. Installing the configuration
must not recreate containers, reset data, or delete keys.

The release command is always `/usr/local/sbin/openclaw-release <40-character SHA>`.
It accepts no repository, branch, origin, config-path, or shell-command override.
It checks the SHA against current `main` of the repository pinned in the root-owned
configuration, rejects unsafe archives, builds before replacing containers, backs
up SQLite through its backup API, and keeps previous images for rollback.
Operator files remain outside the copied source tree; `.env*`, SQLite and private
integration files are excluded when copying source. The private Compose manifest
is never replaced during deployment. Update it explicitly when operational
configuration changes are wanted. Public fork contents cannot select another
repository or host at deployment time.

## GitHub configuration

Set repository variables on **your own repository**:

- `OCI_DEPLOY_READY=true` only after setup; unset or `false` disables auto-deploy.
- `OCI_DEPLOY_REPOSITORY`: exact `owner/repository` running the workflow.
- `OCI_DEPLOY_HOST`: your SSH hostname or IPv4 address.
- `OCI_DEPLOY_USER`: your existing operator account.
- `OCI_PUBLIC_ORIGIN`: your HTTPS origin.
- `OCI_KNOWN_HOSTS`: a verified, pinned SSH known_hosts record for that host.

Set `OCI_DEPLOY_SSH_KEY` as a GitHub secret. Its matching public key must use the
forced-command restriction installed by `scripts/deploy/install.sh`. Successful
`main` pushes and manual CI runs on `main` can deploy; pull requests cannot receive
deployment credentials. Deployment jobs serialize and superseded SHAs are rejected.
The workflow rejects missing target fields and mismatched repository identity
before it attempts SSH. SSH requires the pinned host key.

For one-time bootstrap, prepare the private root configuration first. The manual
`OCI deployment setup` workflow uses temporary `OCI_BOOTSTRAP_SSH_KEY` and
`OCI_DEPLOY_PUBLIC_KEY`; `inspect` reads selected service metadata and `install`
installs the validated command, restricted public key and bounded desktop storage.
Remove the temporary bootstrap secret after use. The installer preserves an
existing desktop filesystem and existing keys. It creates a 512 MiB local loop
filesystem only when no configured backing image exists; this is not a new cloud
volume. Existing data remains in the original location selected by the operator.

For automated releases, set `COMMUNITY_DESKTOP_HOME` to
`<shared_storage_root>/home`. It must be a mounted, bounded filesystem, not just a
directory. The installer prepares that mount for a new empty installation;
preserve the existing mount when migrating. A manually started Compose stack may
use a directory, but must prepare this storage layout before enabling automated
releases. Never mount a new filesystem over an existing desktop home containing
data; preserve and migrate that data explicitly first.

The deployment command retains current/previous image tags and removes only old
SHA tags for its configured project. Other projects, operator backup tags and
unrelated services are untouched. A public health check confirms release identity
and assets; model replies, authenticated workspace use and notifications need
separate checks when affected.
