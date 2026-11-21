#!/bin/bash

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
