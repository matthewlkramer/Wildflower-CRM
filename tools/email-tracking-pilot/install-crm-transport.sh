#!/bin/bash
# Install the production listener alongside the verified port-25 pilot.
set -euo pipefail

source_dir=${1:?Pass the checked-out gateway source directory}
config=/etc/wf-mail-pilot/crm.json
[[ $EUID -eq 0 ]]
test -f /var/lib/wf-mail-pilot/bootstrapped
test -f "$config"

python3 - "$config" <<'PY'
import json
import re
import sys
from pathlib import Path

config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if config["database"] != "/var/lib/wf-mail-pilot/delivery.sqlite":
    raise SystemExit("Use the active gateway database")
senders = sorted(set(address.lower() for address in config["senders"]))
if not senders or not all(re.fullmatch(r"[a-z0-9._%+-]+@[a-z0-9.-]+", address) for address in senders):
    raise SystemExit("Set an exact sender allowlist")
for setting in ("crm_token_file", "route_secret_file"):
    if len(Path(config[setting]).read_bytes().strip()) < 32:
        raise SystemExit(f"Configure {setting}")
Path("/etc/postfix/wf-crm-senders").write_text(
    "".join(f"{address} OK\n" for address in senders), encoding="utf-8",
)
PY
postmap /etc/postfix/wf-crm-senders
chmod 0644 /etc/postfix/wf-crm-senders.db

for module in gateway.py prepare_delivery.py crm_transport.py; do
    install -m 0644 "$source_dir/$module" "/opt/wf-mail-pilot/$module.new"
    mv -T "/opt/wf-mail-pilot/$module.new" "/opt/wf-mail-pilot/$module"
done

# The cloud firewall restricts this port to Google's mail ranges. The exact
# Workspace sender allowlist is also checked at SMTP time. The pipe checks
# and strips the separate authenticated Workspace routing header.
postconf -M '2525/inet=2525 inet n - n - - smtpd'
postconf -e 'wfcrm_sender_checks = check_sender_access hash:/etc/postfix/wf-crm-senders, reject'
postconf -P \
    '2525/inet/mynetworks=127.0.0.0/8,74.125.0.0/16,209.85.128.0/17' \
    '2525/inet/smtpd_tls_security_level=encrypt' \
    '2525/inet/smtpd_client_restrictions=permit_mynetworks,reject' \
    '2525/inet/smtpd_sender_restrictions=$wfcrm_sender_checks' \
    '2525/inet/smtpd_relay_restrictions=permit_mynetworks,reject' \
    '2525/inet/smtpd_recipient_restrictions=permit_mynetworks,reject' \
    '2525/inet/smtpd_reject_unlisted_recipient=no' \
    '2525/inet/content_filter=wfcrm:'
postconf -M 'wfcrm/unix=wfcrm unix - n n - - pipe user=wfmailpilot argv=/usr/bin/python3 -B /opt/wf-mail-pilot/crm_transport.py --config /etc/wf-mail-pilot/crm.json deliver --sender=${sender} --recipient=${recipient}'
postconf -e 'wfcrm_destination_recipient_limit = 1'

cat > /etc/systemd/system/wf-crm-tracking-export.service <<'EOF'
[Unit]
Description=Export observed email opens to Wildflower CRM
After=network-online.target

[Service]
Type=oneshot
User=wfmailpilot
Group=wfmailpilot
ExecStart=/usr/bin/python3 -B /opt/wf-mail-pilot/crm_transport.py --config /etc/wf-mail-pilot/crm.json export
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/wf-mail-pilot
EOF
cat > /etc/systemd/system/wf-crm-tracking-export.timer <<'EOF'
[Unit]
Description=Export Wildflower CRM email opens each minute

[Timer]
OnBootSec=1min
OnUnitInactiveSec=1min

[Install]
WantedBy=timers.target
EOF

postfix check
systemctl daemon-reload
systemctl restart wf-mail-pilot-pixels.service
systemctl reload postfix
systemctl enable --now wf-crm-tracking-export.timer
