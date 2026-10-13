#!/bin/sh
# Install the three user services and start them at boot.
#   ops/install-services.sh            install/refresh the unit files and enable them
#   ops/install-services.sh --start    ...and (re)start all three now
# Needs ~/.config/gm-tools/services.env (copy ops/services.env.example).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
conf="$HOME/.config/gm-tools/services.env"
units="$HOME/.config/systemd/user"
[ -f "$conf" ] || { echo "Missing $conf -- copy $here/services.env.example there and edit it." >&2; exit 1; }
mkdir -p "$units"
for u in foundry gm-tools gm-tools-bridge; do cp "$here/systemd/$u.service" "$units/$u.service"; done
systemctl --user daemon-reload
systemctl --user enable foundry.service gm-tools.service gm-tools-bridge.service
# Boot start for user services needs lingering; without it they start at login.
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  loginctl enable-linger "$USER" 2>/dev/null || echo "NOTE: could not enable lingering. Run: sudo loginctl enable-linger $USER  (until then the services start at login, not at boot)"
fi
if [ "${1:-}" = "--start" ]; then
  systemctl --user restart foundry.service gm-tools.service
  systemctl --user restart gm-tools-bridge.service
fi
echo "Installed. Check with: bin/gm-status"
