#!/usr/bin/env bash
# Обновление сайта до последней версии из GitHub: копия базы → новый код → перезапуск.
set -euo pipefail
APP_DIR=/opt/rassrochka
BRANCH="${BRANCH:-main}"

/usr/local/bin/rassrochka-backup
sudo -u rassrochka git -C "$APP_DIR" fetch -q origin "$BRANCH"
sudo -u rassrochka git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
(cd "$APP_DIR" && sudo -u rassrochka HOME="$APP_DIR" npm ci --omit=dev --no-audit --no-fund --loglevel=error)
install -m 750 "$APP_DIR/deploy/backup.sh" /usr/local/bin/rassrochka-backup
install -m 750 "$APP_DIR/deploy/update.sh" /usr/local/bin/rassrochka-update
systemctl restart rassrochka
sleep 3
systemctl is-active --quiet rassrochka && echo "✓ Обновлено: $(sudo -u rassrochka git -C "$APP_DIR" log --oneline -1)" || { journalctl -u rassrochka -n 40 --no-pager; exit 1; }
