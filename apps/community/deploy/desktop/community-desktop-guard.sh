#!/bin/bash
set -euo pipefail

DESKTOP_IP="${DESKTOP_IP:-172.30.50.3}"
HOST_PUBLIC_IP="${HOST_PUBLIC_IP:?Set HOST_PUBLIC_IP to this server IPv4 address}"
validate_ipv4() {
  local ip="$1" octet
  [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  local IFS=.
  local -a octets
  read -r -a octets <<< "$ip"
  for octet in "${octets[@]}"; do
    (( 10#$octet <= 255 )) || return 1
  done
}
validate_ipv4 "$HOST_PUBLIC_IP" && validate_ipv4 "$DESKTOP_IP" || {
  echo 'HOST_PUBLIC_IP and DESKTOP_IP must be valid IPv4 addresses' >&2
  exit 1
}
command -v nft >/dev/null

if nft list table inet community_desktop_guard >/dev/null 2>&1; then
  destroy='destroy table inet community_desktop_guard'
else
  destroy=''
fi

# nft -f applies this as one transaction. Only this dedicated table is
# destroyed/recreated; the host ruleset and firewalld-owned tables are intact.
{
  [ -z "$destroy" ] || echo "$destroy"
  cat <<EOF
add table inet community_desktop_guard
add chain inet community_desktop_guard input { type filter hook input priority -100; policy accept; }
add chain inet community_desktop_guard forward { type filter hook forward priority -100; policy accept; }
add chain inet community_desktop_guard output { type filter hook output priority -100; policy accept; }
add rule inet community_desktop_guard input ct state established,related accept
add rule inet community_desktop_guard forward ct state established,related accept
add rule inet community_desktop_guard output ct state established,related accept
add rule inet community_desktop_guard input ip saddr 172.30.50.0/28 ip saddr != 172.30.50.2 ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4, $HOST_PUBLIC_IP/32 } reject
add rule inet community_desktop_guard forward ip saddr 172.30.50.0/28 ip saddr != 172.30.50.2 ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4, $HOST_PUBLIC_IP/32 } reject
add rule inet community_desktop_guard output ip saddr 172.30.50.0/28 ip saddr != 172.30.50.2 ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4, $HOST_PUBLIC_IP/32 } reject
EOF
} | nft -f -
