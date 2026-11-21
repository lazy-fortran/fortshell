#!/bin/sh
# Builds build/server/fortshell for the Debian host behind ink.sloppy.at.
# It is built on Debian 13 like the host, with the Fortran runtime linked
# statically, so the host needs no compiler or Fortran libraries.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
fx=${FX_PATH:-$root/build/dependencies/fx}
fortweb=${FORTWEB_PATH:-$root/build/dependencies/fortweb}
for f in "$fx/src/fx_hash.f90" "$fortweb/src/fortweb_server.f90"
do
    test -s "$f" || { echo "missing $f: run fo build first" >&2; exit 1; }
done
mkdir -p "$root/build/server"
docker run --rm -u 0 -v "$root:/src" -v "$fx:/fx:ro" -v "$fortweb:/fortweb:ro" \
    -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" debian:trixie sh -euc '
    apt-get -qq update >/dev/null
    apt-get -qq install -y --no-install-recommends gfortran >/dev/null
    work=$(mktemp -d)
    cd "$work"
    gcc -O2 -c /fx/src/proc/fx_sys.c /fx/src/proc/fx_sha256_hw.c
    gfortran -O2 -fcheck=bounds -c /fx/src/fx_hash.f90 \
        /fortweb/src/fortweb_posix.f90 /fortweb/src/fortweb_proc.f90 \
        /fortweb/src/fortweb_http.f90 /fortweb/src/fortweb_static.f90 \
        /fortweb/src/fortweb_sse.f90 /fortweb/src/fortweb_server.f90
    gfortran -O2 -c /src/src/server/fortshell_store.f90 /src/src/server/fortshell_auth.f90 \
        /src/src/server/fortshell_server.f90 /src/app/fortshell.f90
    gfortran -static-libgfortran -static-libquadmath -static-libgcc -o /src/build/server/fortshell *.o
    chown "$HOST_UID:$HOST_GID" /src/build/server/fortshell'
echo "$root/build/server/fortshell"
