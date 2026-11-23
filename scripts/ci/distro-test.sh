#!/usr/bin/env bash
# Installs a Linux package in a clean container of the target distribution,
# starts Graphite there under Xvfb and runs scripts/smoke.mjs against it.
#   scripts/ci/distro-test.sh <rocky|fedora|arch|ubuntu> <release dir>
set -euo pipefail
distro=$1
dir=$(cd "$2" && pwd)
case "$distro" in
  rocky)  image=rockylinux:9;   pkg=$(ls "$dir"/graphite-*.x86_64.rpm)
          install="dnf install -y /r/$(basename "$pkg") xorg-x11-server-Xvfb" ;;
  fedora) image=fedora:latest;  pkg=$(ls "$dir"/graphite-*.x86_64.rpm)
          install="dnf install -y /r/$(basename "$pkg") xorg-x11-server-Xvfb" ;;
  arch)   image=archlinux:latest; pkg=$(ls "$dir"/graphite-*-x86_64.pacman)
          # Arch is rolling: a full upgrade first (-Syu), as any user would have
          install="pacman -Syu --noconfirm && pacman -U --noconfirm /r/$(basename "$pkg") && pacman -S --noconfirm xorg-server-xvfb" ;;
  ubuntu) image=ubuntu:24.04;   pkg=$(ls "$dir"/graphite_*_amd64.deb)
          install="apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q /r/$(basename "$pkg") xvfb" ;;
  *) echo "unknown distro $distro" >&2; exit 2 ;;
esac
echo "== $distro ($image): $(basename "$pkg")"
name="graphite-$distro"
docker rm -f "$name" >/dev/null 2>&1 || true
# The package's own scripts must have linked /usr/bin/graphite. Root in a
# container: Chromium needs --no-sandbox.
docker run -d --name "$name" --network host -v "$dir:/r:ro" "$image" bash -c "
  set -e
  $install
  test -x /opt/Graphite/graphite
  test -L /usr/bin/graphite || test -x /usr/bin/graphite
  echo PACKAGE-INSTALLED
  Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
  sleep 2
  DISPLAY=:99 GRAPHITE_PROFILE_DIR=/tmp/graphite-profile /usr/bin/graphite --no-sandbox --remote-debugging-port=9555
"
cleanup() { docker logs "$name" 2>&1 | tail -40; docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
SMOKE_ATTACH=1 node "$(dirname "$0")/../smoke.mjs" &
smoke=$!
# The app runs in the foreground of the container: if the container stops
# (install failed, the app crashed), fail now instead of waiting for the timeout.
while kill -0 "$smoke" 2>/dev/null; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != true ]; then
    echo "container stopped before the smoke test finished" >&2
    kill "$smoke" 2>/dev/null || true
    exit 1
  fi
  sleep 3
done
wait "$smoke"
