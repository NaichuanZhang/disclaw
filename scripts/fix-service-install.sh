#!/bin/bash
set -euo pipefail

# ---------------------------------------------------------------------------
# One-time repair for the "bot never came back after reboot" failure.
#
# Root cause: /etc/systemd/system/discordclaw.service is the April-15 copy,
# whose ExecStart=/usr/bin/npx does not exist on this host. Commit e6394bf
# fixed the repo copy on Aug 12 but nothing ever installed it, so the unit
# has never once exec'd. The bot was only ever alive because someone ran
# ./start.sh by hand; the 2026-09-19 10:08 reboot killed that and the unit
# could not take over.
#
# Run with: sudo bash scripts/fix-service-install.sh
# Idempotent: safe to re-run.
# ---------------------------------------------------------------------------

REPO=/home/alex/discordclaw
UNIT=/etc/systemd/system/discordclaw.service

if [ "$EUID" -ne 0 ]; then
  echo "ERROR: must run as root (sudo bash scripts/fix-service-install.sh)" >&2
  exit 1
fi

echo "=== 1/5  Stop the crash loop ==="
# The loop is at ~2200 restarts this boot and was at 610470 before the reboot.
systemctl stop discordclaw 2>/dev/null || true
systemctl reset-failed discordclaw 2>/dev/null || true

echo "=== 2/5  Install the fixed unit (repo -> /etc) ==="
if [ ! -f "$REPO/discordclaw.service" ]; then
  echo "ERROR: $REPO/discordclaw.service missing" >&2
  exit 1
fi
# Keep a copy of whatever is currently installed, once.
if [ -f "$UNIT" ] && [ ! -f "$UNIT.bak-prefix" ]; then
  cp -a "$UNIT" "$UNIT.bak-prefix"
  echo "    backed up old unit -> $UNIT.bak-prefix"
fi
install -m 0644 -o root -g root "$REPO/discordclaw.service" "$UNIT"
systemd-analyze verify "$UNIT" || true
systemctl daemon-reload

echo "=== 3/5  Install logrotate (it is NOT installed: dpkg state 'un') ==="
# Without it, /var/log/syslog grew unbounded to 1.8 GB / 12.9M crash-loop
# lines and nothing would ever have reclaimed it.
if ! command -v logrotate >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y logrotate
else
  echo "    already present, skipping"
fi

echo "=== 4/5  Reclaim the syslog the crash loop wrote ==="
for f in /var/log/syslog /var/log/kern.log; do
  if [ -f "$f" ]; then
    sz=$(stat -c %s "$f")
    # rsyslog opens these O_APPEND, so truncating in place is safe.
    truncate -s 0 "$f"
    echo "    truncated $f (freed $((sz / 1024 / 1024)) MB)"
  fi
done
systemctl kill -s HUP rsyslog 2>/dev/null || true

echo "=== 5/5  Make the journal survive reboots ==="
# /var/log/journal is absent, so journald is volatile: the record of *why*
# the 10:08 reboot happened died with the reboot itself.
mkdir -p /var/log/journal
systemd-tmpfiles --create --prefix /var/log/journal 2>/dev/null || true
if ! grep -qE '^\s*SystemMaxUse=' /etc/systemd/journald.conf; then
  printf 'SystemMaxUse=500M\nSystemKeepFree=2G\n' >> /etc/systemd/journald.conf
  echo "    capped journal at 500M"
fi
systemctl restart systemd-journald

echo
echo "=== Starting the service ==="
systemctl start discordclaw
sleep 20
systemctl status discordclaw --no-pager -l | head -20
echo
echo "=== Health check ==="
curl -sf --max-time 10 http://localhost:3000/api/health && echo "  <- gateway OK" \
  || echo "  gateway not up yet; watch: journalctl -u discordclaw -f"
echo
echo "Done. Verify it survives a reboot:  sudo reboot"
