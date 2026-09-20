FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    DESKTOP_VNC_PORT=5900 \
    DESKTOP_WEBSOCKET_PORT=6080 \
    DESKTOP_CDP_PORT=9222 \
    DESKTOP_START_URL=about:blank

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
       chromium chromium-sandbox ca-certificates dbus-x11 fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
       novnc openbox socat tini websockify x11-utils x11vnc xvfb xterm \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /bin/bash desktop \
    && mkdir -p /home/desktop/.config/openbox /run/desktop \
    && chown -R desktop:desktop /home/desktop /run/desktop

COPY --chmod=0755 entrypoint.sh /usr/local/bin/desktop-entrypoint

USER desktop
WORKDIR /home/desktop
EXPOSE 6080 9222
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/desktop-entrypoint"]
