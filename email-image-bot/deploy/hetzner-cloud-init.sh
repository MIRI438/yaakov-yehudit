#!/bin/bash
# Hetzner Cloud: Create Server > "Cloud config"; Kamatera: Advanced Configuration > "Install Script"
# (and turn on "Keep Server On Failure"). Paste this whole file after filling in the part below.
# Works on any new Ubuntu 22.04 / 24.04 server.
# Runs once when the server is created and sets everything up:
#   - the bot and the website, restarting by themselves after a crash or a reboot;
#   - the website at https://<ip-with-dashes>.sslip.io (a free address with a real certificate);
#   - replies sent straight from Gmail over SMTP port 587 (Hetzner blocks 25 and 465): ~500 a day;
#   - automatic updates: every 5 minutes it checks GitHub and rebuilds when the code changed.
# Never commit this file with real values in it (the repository is public).

# ===================== fill in =====================
# From Railway: the service > Variables > "Raw Editor" > copy everything and paste between the two EOF lines.
# (Sending settings, PORT, PUBLIC_URL and DATA_DIR from there are ignored; this server sets its own.)
# LOGS_KEY: a long secret word of your choice; the log is then at https://<site>/logs?key=<that word>.
# (When /root/bot.env.in was already written by someone else, e.g. a short bootstrap, it is kept.)
if [ ! -s /root/bot.env.in ] && [ ! -s /opt/bot.env ]; then
cat > /root/bot.env.in <<'EOF'
EMAIL_ADDRESS=your.bot@gmail.com
EMAIL_PASSWORD=your16letterapppassword
LOGS_KEY=choose-a-long-secret-word
EOF
fi
# ===================================================
# Some panels (Kamatera) strip backslashes from a pasted script, which breaks it. There, paste only:
#   cat > /root/bot.env.in <<'EOF'
#   EMAIL_ADDRESS=...
#   EMAIL_PASSWORD=...
#   LOGS_KEY=...
#   EOF
#   curl -fsSL https://raw.githubusercontent.com/MIRI438/yaakov-yehudit/claude/image-link-server-cvrrt5/email-image-bot/deploy/hetzner-cloud-init.sh -o /root/setup.sh
#   systemd-run --unit=bot-setup bash /root/setup.sh

set -euo pipefail
exec > >(tee -a /var/log/bot-setup.log) 2>&1
echo "=== setup started $(date)"

REPO=https://github.com/MIRI438/yaakov-yehudit.git
BRANCH=claude/image-link-server-cvrrt5

export DEBIAN_FRONTEND=noninteractive
# A new server often runs its own updates in the first minutes: wait for them instead of failing.
wait_apt() {
  for _ in $(seq 120); do
    fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/lib/dpkg/lock >/dev/null 2>&1 || return 0
    sleep 5
  done
}
wait_apt
apt-get -o DPkg::Lock::Timeout=600 update -y
apt-get -o DPkg::Lock::Timeout=600 install -y git curl ufw psmisc
wait_apt
# Docker's installer does not know the newest Ubuntu releases yet; Ubuntu's own package works there.
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh || apt-get -o DPkg::Lock::Timeout=600 install -y docker.io
systemctl enable --now docker

# A little swap, so the browser never runs the server out of memory.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

IP=$(curl -fsS -m 3 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 || curl -fsS -m 20 https://api.ipify.org)
SITE="${IP//./-}.sslip.io"

# Settings: what was pasted, minus what this server decides, plus the server's own.
mkdir -p /opt/bot-data /opt/caddy
if [ -s /root/bot.env.in ]; then
tr -d '\r' < /root/bot.env.in \
  | sed -E 's/^"?([A-Z0-9_]+)"?\s*=\s*"?(.*[^"])"?\s*$/\1=\2/' \
  | grep -vE '^\s*(#|$)|^(SEND_SCRIPT_URL|SEND_SCRIPT_SECRET|MAIL_RELAY_URL|MAIL_RELAY_SECRET|SMTP_HOST|SMTP_PORT|SMTP_SECURE|PORT|PUBLIC_URL|DATA_DIR)=' \
  | sed -E '/^EMAIL_PASSWORD=/ s/ //g' > /opt/bot.env || true
cat >> /opt/bot.env <<EOF
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
PORT=8080
PUBLIC_URL=http://$IP
EOF
chmod 600 /opt/bot.env
rm -f /root/bot.env.in
fi

# The website behind Caddy, which gets the HTTPS certificate by itself.
cat > /opt/caddy/Caddyfile <<EOF
$SITE {
  reverse_proxy bot:8080
}
http://$IP {
  reverse_proxy bot:8080
}
EOF
docker network create botnet 2>/dev/null || true
docker rm -f caddy 2>/dev/null || true # when the setup runs a second time
docker run -d --name caddy --restart=always --network botnet -p 80:80 -p 443:443 \
  -v /opt/caddy/Caddyfile:/etc/caddy/Caddyfile -v caddy_data:/data caddy:2

# Download, build and (re)start the bot; also used every 5 minutes for updates.
cat > /usr/local/bin/bot-update <<EOF
#!/bin/bash
# Rebuilds and restarts the bot when GitHub has a newer version (or when run with "force").
set -euo pipefail
exec 9>/run/bot-update.lock
flock -n 9 || exit 0
if [ ! -d /opt/bot/.git ]; then
  git clone --branch $BRANCH $REPO /opt/bot
  CHANGED=yes
else
  cd /opt/bot
  git fetch -q origin $BRANCH
  if [ "\$(git rev-parse HEAD)" != "\$(git rev-parse origin/$BRANCH)" ]; then
    git reset -q --hard origin/$BRANCH
    CHANGED=yes
  fi
fi
if [ "\${CHANGED:-}" = yes ] || [ "\${1:-}" = force ] || ! docker ps --format '{{.Names}}' | grep -qx bot; then
  echo "\$(date) updating to \$(git -C /opt/bot log -1 --format='%h %s')"
  docker build -q -t email-image-bot /opt/bot/email-image-bot
  docker rm -f bot 2>/dev/null || true
  docker run -d --name bot --restart=always --init --network botnet \\
    --env-file /opt/bot.env -v /opt/bot-data:/data email-image-bot
  docker image prune -f >/dev/null
fi
EOF
chmod +x /usr/local/bin/bot-update
/usr/local/bin/bot-update force

echo '*/5 * * * * root /usr/local/bin/bot-update >> /var/log/bot-update.log 2>&1' > /etc/cron.d/bot-update

echo "=== setup finished $(date): website https://$SITE"
