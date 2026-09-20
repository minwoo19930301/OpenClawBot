#!/bin/sh
set -eu

display="${DISPLAY:-:99}"
screen="${DESKTOP_SCREEN:-1280x800x24}"
vnc_port="${DESKTOP_VNC_PORT:-5900}"
ws_port="${DESKTOP_WEBSOCKET_PORT:-6080}"
cdp_port="${DESKTOP_CDP_PORT:-9222}"
start_url="${DESKTOP_START_URL:-about:blank}"

xvfb_pid= openbox_pid= vnc_pid= ws_pid= cdp_pid= browser_pid=
Xvfb "$display" -screen 0 "$screen" -nolisten tcp -ac >/run/desktop/xvfb.log 2>&1 &
xvfb_pid=$!
trap 'kill "$xvfb_pid" "$openbox_pid" "$vnc_pid" "$ws_pid" "$cdp_pid" "$browser_pid" 2>/dev/null || true' INT TERM EXIT

i=0
until xdpyinfo -display "$display" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 50 ] || { echo "Xvfb did not become ready" >&2; exit 1; }
  sleep 0.1
done

openbox >/run/desktop/openbox.log 2>&1 &
openbox_pid=$!

# x11vnc is loopback-only. The app-facing websocket bridge is the only VNC
# transport exposed on the container network; it has no unauthenticated host port.
x11vnc -display "$display" -rfbport "$vnc_port" -localhost -forever -shared -nopw -quiet >/run/desktop/x11vnc.log 2>&1 &
vnc_pid=$!
websockify --web=/usr/share/novnc "$ws_port" "127.0.0.1:$vnc_port" >/run/desktop/websockify.log 2>&1 &
ws_pid=$!

# Do not add --no-sandbox. Debian's Chromium sandbox must remain enabled.
chromium \
  --display="$display" \
  --user-data-dir=/home/desktop/chromium \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9223 \
  --no-first-run --no-default-browser-check \
  "$start_url" >/run/desktop/chromium.log 2>&1 &
browser_pid=$!

socat "TCP-LISTEN:$cdp_port,bind=0.0.0.0,reuseaddr,fork" TCP:127.0.0.1:9223 >/run/desktop/socat.log 2>&1 &
cdp_pid=$!

wait "$browser_pid"
