#!/bin/bash
# Install the production listener alongside the verified port-25 pilot.
set -euo pipefail

source_dir=${1:?Pass the checked-out gateway source directory}
config=/etc/wf-mail-pilot/crm.json
[[ $EUID -eq 0 ]]
test -f /var/lib/wf-mail-pilot/bootstrapped
test -f "$config"

sender_map=$(python3 - "$config" <<'PY'
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
domain = config.get("workspace_domain")
group = config.get("routing_group")
if group:
    if (not isinstance(domain, str) or not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+", domain)
            or not re.fullmatch(r"groups/[a-zA-Z0-9_-]+", group)):
        raise SystemExit("Configure the exact Workspace domain and Cloud Identity group")
    Path("/etc/postfix/wf-crm-workspace-senders").write_text(
        rf"/^[a-z0-9._%+-]+@{re.escape(domain)}$/ OK" + "\n", encoding="utf-8",
    )
    print("regexp:/etc/postfix/wf-crm-workspace-senders")
else:
    Path("/etc/postfix/wf-crm-senders").write_text(
        "".join(f"{address} OK\n" for address in senders), encoding="utf-8",
    )
    print("hash:/etc/postfix/wf-crm-senders")
PY
)
if [[ "$sender_map" == hash:* ]]; then
    postmap /etc/postfix/wf-crm-senders
    chmod 0644 /etc/postfix/wf-crm-senders.db
fi

for module in gateway.py prepare_delivery.py crm_transport.py sync_routing_group.py; do
    install -m 0644 "$source_dir/$module" "/opt/wf-mail-pilot/$module.new"
    mv -T "/opt/wf-mail-pilot/$module.new" "/opt/wf-mail-pilot/$module"
done

# The firewall restricts this port to Google's mail ranges. Workspace filters
# the live group before routing. The pipe also requires and strips the private
# routing header and checks the active CRM grant before tracking a message.
postconf -M '2525/inet=2525 inet n - n - - smtpd'
postconf -e "wfcrm_sender_checks = check_sender_access $sender_map, reject"
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

cat > /etc/systemd/system/wf-crm-routing-group.service <<'EOF'
[Unit]
Description=Reconcile the Workspace Gmail routing group with active CRM grants
After=network-online.target

[Service]
Type=oneshot
User=wfmailpilot
Group=wfmailpilot
ExecStart=/usr/bin/python3 -B /opt/wf-mail-pilot/sync_routing_group.py --config /etc/wf-mail-pilot/crm.json
TimeoutStartSec=55s
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
EOF
cat > /etc/systemd/system/wf-crm-routing-group.timer <<'EOF'
[Unit]
Description=Refresh Gmail tracking enrollment each minute

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
if [[ "$sender_map" == regexp:* ]]; then
    systemctl enable --now wf-crm-routing-group.timer
else
    systemctl disable --now wf-crm-routing-group.timer
fi
