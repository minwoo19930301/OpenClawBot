#!/bin/bash
set -euo pipefail

DESKTOP_IP="${DESKTOP_IP:-172.30.50.3}"
HOST_PUBLIC_IP="${HOST_PUBLIC_IP:-168.107.91.96}"
FORWARD_CHAIN=COMMUNITY_DESKTOP_EGRESS
INPUT_CHAIN=COMMUNITY_DESKTOP_INPUT

command -v iptables >/dev/null

ensure_chain() {
  local chain="$1"
  iptables -w -n -L "$chain" >/dev/null 2>&1 || iptables -w -N "$chain"
  iptables -w -F "$chain"
}

hook() {
  local parent="$1" chain="$2"
  iptables -w -C "$parent" -s "$DESKTOP_IP/32" -j "$chain" 2>/dev/null || \
    iptables -w -I "$parent" 1 -s "$DESKTOP_IP/32" -j "$chain"
}

ensure_chain "$FORWARD_CHAIN"
ensure_chain "$INPUT_CHAIN"

# Preserve return traffic, then reject private, special-use, metadata, and the
# host public address. The final RETURN leaves ordinary public egress intact.
for chain in "$FORWARD_CHAIN" "$INPUT_CHAIN"; do
  iptables -w -A "$chain" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  for cidr in \
    0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 \
    169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 \
    192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 \
    224.0.0.0/4 240.0.0.0/4 "$HOST_PUBLIC_IP/32"; do
    iptables -w -A "$chain" -d "$cidr" -j REJECT --reject-with icmp-port-unreachable
  done
  iptables -w -A "$chain" -j RETURN
done

hook DOCKER-USER "$FORWARD_CHAIN"
# Docker 29's bridge forwarding path can bypass DOCKER-USER for containers on
# the same bridge; scope the same rule at DOCKER-FORWARD when that chain exists.
if iptables -w -n -L DOCKER-FORWARD >/dev/null 2>&1; then
  hook DOCKER-FORWARD "$FORWARD_CHAIN"
fi
hook OUTPUT "$FORWARD_CHAIN"
hook INPUT "$INPUT_CHAIN"
