#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
target=${FORTSHELL_SSH_TARGET:-root@sloppy}
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT HUP INT TERM

for file in index.html main.js main.wasm shell.js sw.js
do
    test -s "$root/build/web/$file"
done
COPYFILE_DISABLE=1 tar --no-xattrs -C "$root/build/web" --exclude=obj --exclude='*.map' -czf "$archive" .
test -x "$root/build/server/fortshell" || { echo 'run tools/build-server.sh first' >&2; exit 1; }
scp -q "$archive" "$target:/tmp/fortshell-web.tgz"
scp -q "$root/deploy/nginx.conf" "$target:/tmp/fortshell-nginx.conf"
scp -q "$root/build/server/fortshell" "$target:/tmp/fortshell-server"
scp -q "$root/deploy/fortshell.service" "$target:/tmp/fortshell.service"
ssh "$target" 'bash -s' <<'REMOTE'
set -euo pipefail
domain=ink.sloppy.at
release=/srv/fortshell/releases/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$release" /var/www/html
tar -xzf /tmp/fortshell-web.tgz -C "$release"
rm -f /tmp/fortshell-web.tgz
chown -R root:root "$release"
find "$release" -type d -exec chmod 0755 {} +
find "$release" -type f -exec chmod 0644 {} +

if [ ! -s "/etc/letsencrypt/live/$domain/fullchain.pem" ]
then
    cat > /etc/nginx/sites-available/fortshell-bootstrap.conf <<'BOOTSTRAP'
server {
    listen 80;
    listen [::]:80;
    server_name ink.sloppy.at;
    location ^~ /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}
BOOTSTRAP
    ln -sfn /etc/nginx/sites-available/fortshell-bootstrap.conf /etc/nginx/sites-enabled/fortshell-bootstrap.conf
    nginx -t
    systemctl reload nginx
    certbot certonly --webroot -w /var/www/html -d "$domain" \
        --non-interactive --agree-tos --keep-until-expiring
    rm -f /etc/nginx/sites-enabled/fortshell-bootstrap.conf /etc/nginx/sites-available/fortshell-bootstrap.conf
fi

mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/fortshell <<'HOOK'
#!/bin/sh
set -eu
case " ${RENEWED_DOMAINS:-} " in
    *" ink.sloppy.at "*)
        nginx -t
        systemctl reload nginx
        ;;
esac
HOOK
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/fortshell

# The server runs as its own user and keeps documents in /srv/fortshell/data.
# The first deployment writes the login token to a root-only file instead of
# printing it.
id fortshell >/dev/null 2>&1 || useradd --system --home-dir /srv/fortshell/data --shell /usr/sbin/nologin fortshell
server=/srv/fortshell/server/$(basename "$release")
mkdir -p "$server"
install -m 0755 /tmp/fortshell-server "$server/fortshell"
rm -f /tmp/fortshell-server
if [ ! -d /srv/fortshell/data ]
then
    install -d -m 0700 -o fortshell -g fortshell /srv/fortshell/data
    runuser -u fortshell -- "$server/fortshell" init --data /srv/fortshell/data > /root/fortshell-login-token
    chmod 0600 /root/fortshell-login-token
fi
previous_server=
if [ -L /srv/fortshell/server/current ]; then previous_server=$(readlink -f /srv/fortshell/server/current); fi
ln -sfn "$server" /srv/fortshell/server/current
install -m 0644 /tmp/fortshell.service /etc/systemd/system/fortshell.service
rm -f /tmp/fortshell.service
systemctl daemon-reload
systemctl enable --quiet fortshell
systemctl restart fortshell
for i in $(seq 50)
do
    if curl -fsS -o /dev/null http://127.0.0.1:4180/; then break; fi
    if [ "$i" = 50 ]
    then
        if [ -n "$previous_server" ]; then ln -sfn "$previous_server" /srv/fortshell/server/current; systemctl restart fortshell; fi
        exit 1
    fi
    sleep 0.2
done

previous=
if [ -L /srv/fortshell/current ]; then previous=$(readlink -f /srv/fortshell/current); fi
ln -sfn "$release" /srv/fortshell/current.next
mv -Tf /srv/fortshell/current.next /srv/fortshell/current
install -m 0644 /tmp/fortshell-nginx.conf /etc/nginx/sites-available/fortshell.conf
rm -f /tmp/fortshell-nginx.conf
ln -sfn /etc/nginx/sites-available/fortshell.conf /etc/nginx/sites-enabled/fortshell.conf
if ! nginx -t
then
    if [ -n "$previous" ]; then ln -sfn "$previous" /srv/fortshell/current; fi
    exit 1
fi
systemctl reload nginx
REMOTE
curl --fail --silent --show-error --retry 6 --retry-delay 2 \
    --retry-all-errors https://ink.sloppy.at/ >/dev/null
printf '%s\n' 'https://ink.sloppy.at/'
