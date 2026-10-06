#!/bin/bash
# One-time installation through the existing operator SSH credential.
set -euo pipefail
umask 077
read -r public_key
[[ "$public_key" == ssh-ed25519\ * ]] || exit 2
[[ "$public_key" != *$'\n'* ]] || exit 2
install -o root -g root -m 755 /home/opc/release.py /usr/local/sbin/openclaw-release
cat > /usr/local/bin/openclaw-deploy-request <<'SH'
#!/bin/sh
exec sudo -n /usr/local/sbin/openclaw-release "$SSH_ORIGINAL_COMMAND"
SH
chmod 755 /usr/local/bin/openclaw-deploy-request
mkdir -p /home/opc/.ssh
touch /home/opc/.ssh/authorized_keys
if ! grep -Fq "$public_key" /home/opc/.ssh/authorized_keys; then
  printf 'restrict,command="/usr/local/bin/openclaw-deploy-request" %s\n' "$public_key" >> /home/opc/.ssh/authorized_keys
fi
chown -R opc:opc /home/opc/.ssh
chmod 700 /home/opc/.ssh
chmod 600 /home/opc/.ssh/authorized_keys
# The OCI Run Command account gets the same validated deployment command only.
printf 'ocarun ALL=(root) NOPASSWD: /usr/local/sbin/openclaw-release *\n' > /etc/sudoers.d/openclaw-deploy
chmod 440 /etc/sudoers.d/openclaw-deploy
visudo -cf /etc/sudoers.d/openclaw-deploy

# A bounded filesystem preserves the shared desktop through image updates.
root=/var/lib/community-shared
mkdir -p "$root/home"
chmod 700 "$root"
if [ ! -f "$root/home.ext4" ]; then
  test "$(df --output=avail -B1 "$root" | tail -1)" -gt 2147483648
  fallocate -l 512M "$root/home.ext4"
  mkfs.ext4 -q -F "$root/home.ext4"
fi
mountpoint -q "$root/home" || mount -o loop,nodev,nosuid "$root/home.ext4" "$root/home"
chown 10001:10001 "$root/home"
chmod 700 "$root/home"
if ! grep -Fq "$root/home.ext4 " /etc/fstab; then
  printf '%s/home.ext4 %s/home ext4 loop,nodev,nosuid,nofail,x-systemd.automount 0 0\n' "$root" "$root" >> /etc/fstab
fi
systemctl daemon-reload
echo 'Restricted deployment command and bounded shared desktop storage installed.'
