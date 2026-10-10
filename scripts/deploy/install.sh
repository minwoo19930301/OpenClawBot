#!/bin/bash
# Run only through the operator's existing administrative credential.
# Prepare root-owned /etc/openclaw/deployment.json and compose.yml first.
set -euo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'Run the installer as root.' >&2; exit 2; }
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
read -r public_key
[[ "$public_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [^[:cntrl:]]*)?$ ]] || exit 2
# Values are validated data, never sourced as shell code.
mapfile -t config < <(python3 - "$source_dir/release.py" <<'PY'
import importlib.util, sys
spec=importlib.util.spec_from_file_location('release',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
config=module.load_config()
module.check_install_storage(config)
for key in ['deployment_user','shared_storage_root','run_command_user']:
    print(config.get(key,''))
PY
)
[[ ${#config[@]} -eq 3 ]] || { echo 'Prepare the private deployment configuration first.' >&2; exit 2; }
deploy_user="${config[0]}"
shared_root="${config[1]}"
run_command_user="${config[2]}"
deploy_home="$(getent passwd "$deploy_user" | cut -d: -f6)"
[[ "$deploy_home" == /* && -d "$deploy_home" ]] || exit 2
install -o root -g root -m 755 "$source_dir/release.py" /usr/local/sbin/openclaw-release
cat > /usr/local/bin/openclaw-deploy-request <<'SH'
#!/bin/sh
exec sudo -n /usr/local/sbin/openclaw-release "$SSH_ORIGINAL_COMMAND"
SH
chown root:root /usr/local/bin/openclaw-deploy-request
chmod 755 /usr/local/bin/openclaw-deploy-request
mkdir -p "$deploy_home/.ssh"
touch "$deploy_home/.ssh/authorized_keys"
restricted_key='restrict,command="/usr/local/bin/openclaw-deploy-request" '"$public_key"
key_material="$(printf '%s\n' "$public_key" | cut -d' ' -f2)"
if grep -Fq "$key_material" "$deploy_home/.ssh/authorized_keys"; then
  if grep -F "$key_material" "$deploy_home/.ssh/authorized_keys" | grep -Fvx "$restricted_key" >/dev/null; then
    echo 'This deployment key already has a different authorization; restrict it explicitly first.' >&2
    exit 2
  fi
else
  printf '%s\n' "$restricted_key" >> "$deploy_home/.ssh/authorized_keys"
fi
chown "$deploy_user:$(id -gn "$deploy_user")" "$deploy_home/.ssh" "$deploy_home/.ssh/authorized_keys"
chmod 700 "$deploy_home/.ssh"
chmod 600 "$deploy_home/.ssh/authorized_keys"
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/openclaw-release *\n' "$deploy_user" > /etc/sudoers.d/openclaw-deploy
if [[ -n "$run_command_user" ]]; then
  id "$run_command_user" >/dev/null
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/openclaw-release *\n' "$run_command_user" >> /etc/sudoers.d/openclaw-deploy
fi
chmod 440 /etc/sudoers.d/openclaw-deploy
visudo -cf /etc/sudoers.d/openclaw-deploy

# A bounded filesystem preserves the desktop. Never replace an existing image.
mkdir -p "$shared_root/home"
chmod 700 "$shared_root"
if [[ ! -f "$shared_root/home.ext4" ]]; then
  test "$(df --output=avail -B1 "$shared_root" | tail -1)" -gt 2147483648
  fallocate -l 512M "$shared_root/home.ext4"
  mkfs.ext4 -q -F "$shared_root/home.ext4"
fi
mountpoint -q "$shared_root/home" || mount -o loop,nodev,nosuid "$shared_root/home.ext4" "$shared_root/home"
chown 10001:10001 "$shared_root/home"
chmod 700 "$shared_root/home"
if ! grep -Fq "$shared_root/home.ext4 " /etc/fstab; then
  printf '%s/home.ext4 %s/home ext4 loop,nodev,nosuid,nofail,x-systemd.automount 0 0\n' "$shared_root" "$shared_root" >> /etc/fstab
fi
systemctl daemon-reload
echo 'Restricted deployment command and bounded shared desktop storage installed.'
