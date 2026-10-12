#!/bin/bash
# Paste into Oracle Cloud: Create instance → Advanced options → Management → "Paste cloud-init script".
# Runs once when the server is first created: installs Docker, downloads the bot and starts it.
# The bot restarts automatically if it crashes or the server reboots.
# Fill in the two lines below before pasting.
EMAIL_ADDRESS='your.bot@gmail.com'
EMAIL_PASSWORD='your16letterapppassword'

set -e
apt-get update -y && apt-get install -y git curl
curl -fsSL https://get.docker.com | sh

git clone --branch claude/image-link-server-cvrrt5 https://github.com/MIRI438/yaakov-yehudit.git /opt/bot
cd /opt/bot/email-image-bot
printf 'EMAIL_ADDRESS=%s\nEMAIL_PASSWORD=%s\n' "$EMAIL_ADDRESS" "${EMAIL_PASSWORD// /}" > .env
chmod 600 .env

docker build -t email-image-bot .
docker run -d --name email-image-bot --restart=always --init --env-file .env email-image-bot
