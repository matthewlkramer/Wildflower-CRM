#!/bin/bash
# The startup script bundle defines GATEWAY_SOURCE and DELIVERY_SOURCE above
# this file, using base64-encoded copies of the two pilot Python modules.
set -euo pipefail
umask 027

metadata() {
    curl -fsS -H 'Metadata-Flavor: Google' \
        "http://metadata.google.internal/computeMetadata/v1/instance/$1"
}

public_ip=$(metadata network-interfaces/0/access-configs/0/external-ip)
pilot_domain=$(metadata attributes/mail-pilot-domain)
reply_subject=$(metadata attributes/mail-pilot-reply-subject)
[[ "$public_ip" =~ ^[0-9.]+$ && "$pilot_domain" =~ ^[a-z0-9.-]+$ && -n "$reply_subject" ]]

if [[ -e /var/lib/wf-mail-pilot/bootstrapped ]]; then
    exit 0
fi

export DEBIAN_FRONTEND=noninteractive
printf '%s\n' 'postfix postfix/main_mailer_type select No configuration' | debconf-set-selections
apt-get update -qq
apt-get install -y -qq postfix nginx python3-venv
if ! id wfmailpilot >/dev/null 2>&1; then
    useradd --system --shell /usr/sbin/nologin wfmailpilot
fi
install -d -m 0755 /opt/wf-mail-pilot /var/www/wf-mail-pilot-acme
install -d -m 0750 -o root -g wfmailpilot /etc/wf-mail-pilot
install -d -m 0750 -o wfmailpilot -g wfmailpilot /var/lib/wf-mail-pilot
printf '%s' "$GATEWAY_SOURCE" | base64 -d > /opt/wf-mail-pilot/gateway.py
printf '%s' "$DELIVERY_SOURCE" | base64 -d > /opt/wf-mail-pilot/prepare_delivery.py
chmod 0644 /opt/wf-mail-pilot/*.py

python3 - "$public_ip" "$pilot_domain" "$reply_subject" <<'PY'
import json
import sys
from pathlib import Path

address, domain, subject = sys.argv[1:]
sender = f"mail-pilot-sender@{domain}"
recipients = [f"mail-pilot-{number:02d}@{domain}" for number in range(1, 5)]
Path("/etc/wf-mail-pilot/config.json").write_text(json.dumps({
    "sender": sender,
    "recipients": recipients,
    "reply_subject": subject,
    "tracking_origin": f"https://{address}",
    "database": "/var/lib/wf-mail-pilot/delivery.sqlite",
    "relay_host": "smtp-relay.gmail.com",
    "relay_port": 587,
}) + "\n", encoding="utf-8")
Path("/etc/postfix/wf-mail-pilot-senders").write_text(f"{sender} OK\n", encoding="utf-8")
Path("/etc/postfix/wf-mail-pilot-recipients").write_text(
    "".join(f"{recipient} OK\n" for recipient in recipients), encoding="utf-8",
)
Path("/etc/postfix/wf-mail-pilot-transport").write_text(
    "".join(f"{recipient} wfmailpilot:\n" for recipient in recipients), encoding="utf-8",
)
PY
chgrp wfmailpilot /etc/wf-mail-pilot/config.json
chmod 0640 /etc/wf-mail-pilot/config.json

cat > /etc/nginx/sites-available/wf-mail-pilot-acme <<'EOF'
server {
    listen 80 default_server;
    server_name _;
    access_log off;
    location ^~ /.well-known/acme-challenge/ { root /var/www/wf-mail-pilot-acme; }
    location / { return 404; }
}
EOF
unlink /etc/nginx/sites-enabled/default 2>/dev/null || true
ln -sfn /etc/nginx/sites-available/wf-mail-pilot-acme /etc/nginx/sites-enabled/wf-mail-pilot-acme
nginx -t
systemctl enable --now nginx
systemctl reload nginx

python3 -m venv /opt/wf-mail-pilot/certbot
/opt/wf-mail-pilot/certbot/bin/pip --quiet install 'certbot>=5.4,<6'
certbot=/opt/wf-mail-pilot/certbot/bin/certbot
(umask 022
 "$certbot" certonly --non-interactive --agree-tos --register-unsafely-without-email \
    --preferred-profile shortlived --webroot --webroot-path /var/www/wf-mail-pilot-acme \
    --cert-name wf-mail-pilot --ip-address "$public_ip" --keep-until-expiring)

cat > /etc/systemd/system/wf-mail-pilot-pixels.service <<'EOF'
[Unit]
Description=Wildflower mail pilot tracking image service
After=network.target

[Service]
User=wfmailpilot
Group=wfmailpilot
ExecStart=/usr/bin/python3 -B /opt/wf-mail-pilot/gateway.py --config /etc/wf-mail-pilot/config.json serve-pixels
Restart=on-failure
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/wf-mail-pilot

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/nginx/sites-available/wf-mail-pilot-https <<'EOF'
server {
    listen 443 ssl default_server;
    server_name _;
    ssl_certificate /etc/letsencrypt/live/wf-mail-pilot/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wf-mail-pilot/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    access_log off;
    location ~ ^/api/email-tracking/track/[A-Za-z0-9_-]+\.gif$ {
        proxy_pass http://127.0.0.1:8081;
    }
    location / { return 404; }
}
EOF
ln -sfn /etc/nginx/sites-available/wf-mail-pilot-https /etc/nginx/sites-enabled/wf-mail-pilot-https

postmap /etc/postfix/wf-mail-pilot-senders
postmap /etc/postfix/wf-mail-pilot-recipients
postmap /etc/postfix/wf-mail-pilot-transport
chmod 0644 /etc/postfix/wf-mail-pilot-*.db
if [[ ! -f /etc/postfix/main.cf ]]; then
    install -m 0644 /usr/share/postfix/main.cf.debian /etc/postfix/main.cf
fi
postconf -e \
    "myhostname = mail-pilot.$pilot_domain" \
    'inet_interfaces = all' \
    'inet_protocols = ipv4' \
    'mydestination =' \
    "relay_domains = $pilot_domain" \
    'relay_recipient_maps = hash:/etc/postfix/wf-mail-pilot-recipients' \
    'transport_maps = hash:/etc/postfix/wf-mail-pilot-transport' \
    'mynetworks = 127.0.0.0/8' \
    'smtpd_sender_restrictions = check_sender_access hash:/etc/postfix/wf-mail-pilot-senders, reject' \
    'smtpd_relay_restrictions = reject_unauth_destination' \
    'smtpd_recipient_restrictions = reject_unlisted_recipient' \
    'smtpd_tls_security_level = encrypt' \
    'smtpd_tls_cert_file = /etc/letsencrypt/live/wf-mail-pilot/fullchain.pem' \
    'smtpd_tls_key_file = /etc/letsencrypt/live/wf-mail-pilot/privkey.pem' \
    'message_size_limit = 26214400' \
    'wfmailpilot_destination_recipient_limit = 1'
postconf -M 'wfmailpilot/unix=wfmailpilot unix - n n - - pipe user=wfmailpilot argv=/usr/bin/python3 -B /opt/wf-mail-pilot/gateway.py --config /etc/wf-mail-pilot/config.json deliver --sender=${sender} --recipient=${recipient}'

install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/wf-mail-pilot <<'EOF'
#!/bin/sh
set -eu
systemctl reload nginx
systemctl reload postfix
EOF
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/wf-mail-pilot
cat > /etc/systemd/system/wf-mail-pilot-renew.service <<'EOF'
[Unit]
Description=Renew the Wildflower mail pilot certificate

[Service]
Type=oneshot
UMask=0022
ExecStart=/opt/wf-mail-pilot/certbot/bin/certbot renew --quiet
EOF
cat > /etc/systemd/system/wf-mail-pilot-renew.timer <<'EOF'
[Unit]
Description=Check the short-lived mail pilot certificate twice daily

[Timer]
OnCalendar=*-*-* 02,14:00:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF

postfix check
nginx -t
systemctl daemon-reload
systemctl enable --now wf-mail-pilot-pixels.service wf-mail-pilot-renew.timer postfix
systemctl restart postfix
systemctl reload nginx
curl -fsS --connect-to "$public_ip:443:127.0.0.1:443" \
    -o /dev/null "https://$public_ip/api/email-tracking/track/healthcheck.gif"
touch /var/lib/wf-mail-pilot/bootstrapped
printf '%s\n' 'Wildflower mail pilot gateway is ready for SMTP TLS verification.'
