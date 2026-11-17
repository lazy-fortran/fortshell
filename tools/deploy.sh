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
scp -q "$archive" "$target:/tmp/fortshell-web.tgz"
scp -q "$root/deploy/nginx.conf" "$target:/tmp/fortshell-nginx.conf"
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
