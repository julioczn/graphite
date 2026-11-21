#!/bin/bash

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Ubuntu 23.10+ blocks unprivileged user namespaces through AppArmor, and the
# stock check above runs as root so it never notices. Give the binary a
# profile that allows them (same approach as VS Code / Chrome) and keep the
# SUID helper as a fallback for systems without AppArmor.
APPARMOR_PROFILE='/etc/apparmor.d/${executable}'
if [ -d /etc/apparmor.d ] && apparmor_parser --help 2>&1 | grep -q -- '--replace'; then
    cat > "$APPARMOR_PROFILE" <<APPARMOR
abi <abi/4.0>,
include <tunables/global>

profile ${executable} /opt/${sanitizedProductName}/${executable} flags=(unconfined) {
  userns,

  include if exists <local/${executable}>
}
APPARMOR
    apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE" || true
fi
chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
