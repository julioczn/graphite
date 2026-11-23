#!/bin/bash

# Upgrades run this too: rpm calls it after the new version's install with $1 =
# copies left (1), deb with "upgrade". Only clean up on a real removal.
case "$1" in
    1|upgrade|failed-upgrade) exit 0 ;;
esac

# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/usr/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

# Drop the AppArmor profile installed by after-install
if [ -f '/etc/apparmor.d/${executable}' ]; then
    apparmor_parser --remove '/etc/apparmor.d/${executable}' 2>/dev/null || true
    rm -f '/etc/apparmor.d/${executable}'
fi
