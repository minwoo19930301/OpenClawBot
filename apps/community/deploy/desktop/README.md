# Private browser desktop container

This directory is a multi-architecture (`linux/amd64` and `linux/arm64`) Debian desktop image for a separately authenticated application proxy. It downloads the official Google Chrome package for the target architecture and starts Google Chrome under Xvfb and Openbox, includes an `xterm` terminal for the remote Linux desktop, serves the VNC display through websockify/noVNC, and exposes Chrome DevTools Protocol (CDP) on the private container network and host loopback only. The ARM64 image was verified on the existing Oracle Linux OCI host with Google Chrome `153.0.8010.52`: sandboxed startup, CDP navigation/screenshot, and the VNC handshake passed. The official `current` download tracks stable Chrome on a fresh build; retain the image digest and previous image for release rollback.

The internal endpoints are:

| purpose | container endpoint | application proxy contract |
| --- | --- | --- |
| VNC websocket | `desktop-<room UUID>:6080/websockify` | authenticated `/api/rooms/<room UUID>/desktop/ws` websocket proxy |
| CDP | `http://desktop-<room UUID>:9222` | backend-only, allowlisted CDP client for this Google Chrome process |
| raw VNC | `127.0.0.1:5900` inside the container | never proxied or published |

The community application must perform authentication and authorization before proxying the websocket. The desktop service itself has no user-account or token endpoint. The example publishes ports on host loopback for host diagnostics; in the production Compose deployment the app reaches the desktop over the dedicated `community-desktop` network, using the desktop service hostname and internal ports (`6080` for VNC and `9222` for CDP), while WAN clients cannot reach that network. Google Chrome itself listens on container loopback port `9223`; a `socat` bridge provides the container `9222` endpoint. Restrict the proxy to the intended Chrome target and commands.

Required runtime inputs are `DESKTOP_START_URL` (default `about:blank`) and, optionally, `DESKTOP_SCREEN` (default `1280x800x24`). The example also makes the internal ports explicit through `DESKTOP_VNC_PORT`, `DESKTOP_WEBSOCKET_PORT`, and `DESKTOP_CDP_PORT` defaults in the image. There are no credentials in this container. The app uses `COMMUNITY_DESKTOP_MAP` with a room UUID and the corresponding desktop service hostname; see the parent deployment README. For the containerized app, set `COMMUNITY_HOST=0.0.0.0`; the local-development `.env.example` loopback bind is not suitable inside this container.

Run from this directory with an already installed Docker/Compose:

```sh
docker compose -f compose.example.yml build
docker compose -f compose.example.yml up -d
```

Build both OCI architectures from a builder that supports them:

```sh
docker buildx build --platform linux/amd64,linux/arm64 -t registry.example/community-desktop:0.1 --push .
```

The Compose example applies a 2 GiB memory limit, one CPU, and a 256 PID limit, drops all Linux capabilities, enables `no-new-privileges`, uses a dedicated bridge subnet, and runs the image as UID 10001. Treat 2 GiB as a practical minimum starting point; this is not evidence that the workload fits an OCI 1 GB E2 Micro. Google Chrome plus Xvfb must be measured on the target host before deployment.

The bridge needs internet for ordinary browser navigation. Before admitting users, install the reboot-persistent bridge sysctl, Docker forwarding drop-in, and `community-desktop-firewall.service`/`community-desktop-guard.sh` described below. Apply host firewall policy for the dedicated `172.30.50.0/28` subnet to block private, loopback, link-local, and OCI metadata destinations while allowing normal public egress. The deployed service uses the scoped nftables table described below; the legacy iptables helper is reference material only. It blocks the OCI metadata address, private networks and the host public IP for the desktop source while allowing established replies and public web traffic.

For a reboot-persistent host installation, copy `99-community-desktop-bridge.conf` to `/etc/sysctl.d/99-community-desktop-bridge.conf` and persist `br_netfilter` in `/etc/modules-load.d/community-desktop.conf`, then run `modprobe br_netfilter` followed by `sysctl --system`. This makes same-bridge desktop egress visible to the scoped filter; IPv6 bridge filtering stays disabled because the Docker bridge is IPv4-only. Then copy `community-desktop-guard.sh` to `/usr/local/sbin/community-desktop-guard`, install `community-desktop-firewall.service`, and install the Docker drop-in from `docker-community-desktop-firewall.conf` as `/etc/systemd/system/docker.service.d/20-community-desktop-firewall.conf`. The service uses an independent `inet community_desktop_guard` nftables table with input/forward/output priority `-100`; `nft -f` replaces only this table in one transaction. Run `systemctl daemon-reload` and `systemctl enable --now community-desktop-firewall.service` after installation. It survives firewalld reload because firewalld owns separate tables. Established/related traffic is accepted before the desktop source filter, so app-to-desktop replies remain allowed. The legacy iptables helper remains for reference but is not required by this service.

Google Chrome is deliberately started without `--no-sandbox`. Its Linux sandbox is a required security boundary. The image does not add `SYS_ADMIN` or a permissive security profile. If the target kernel or default seccomp/user-namespace policy prevents Chrome’s sandbox from starting, fail closed and fix host/runtime compatibility rather than disabling the sandbox.

The earlier Chromium-based image on the tested Oracle Linux 9.8 ARM64 host hit Docker’s stock seccomp rejection for Chromium’s namespace setup. The verified profile derived from Docker/Moby’s default profile allows only these additional syscall names: `clone`, `clone3`, `unshare`, `setns`, `mount`, `umount2`, `pivot_root`, and `chroot`. Google Chrome `153.0.8010.52` was also verified with this profile and the sandbox enabled. Keep the default profile’s deny behavior and review the derived profile as a deployment artifact; do not replace it with `seccomp=unconfined` in production.

The design intentionally has no host mounts, Docker socket, host networking, public ports, or browser credentials. Loopback host bindings are reachable only by host-local processes; the community app container uses the private desktop network. Network controls are not a substitute for application authentication: the app must authenticate every desktop session and avoid forwarding arbitrary CDP traffic.

References:

- [Docker Compose service resource and capability controls](https://docs.docker.com/reference/compose-file/services/)
- [Docker Compose resource limits](https://docs.docker.com/reference/compose-file/deploy/)
- [Google Chrome download and supported platforms](https://support.google.com/chrome/answer/95346?co=GENIE.Platform%3DDesktop&hl=en)
- [Chromium Linux sandboxing](https://chromium.googlesource.com/chromium/src/+/main/docs/linux_sandboxing.md)
- [OCI Container Instances overview](https://docs.oracle.com/en-us/iaas/Content/container-instances/overview-of-container-instances.htm)
