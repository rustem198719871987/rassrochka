#!/usr/bin/env bash
# Обновление сайта до последней версии из GitHub: копия базы → новый код → перезапуск.
set -euo pipefail
APP_DIR=/opt/rassrochka
BRANCH="${BRANCH:-main}"

/usr/local/bin/rassrochka-backup
# код: git, а если GitHub не отвечает — архивом. Приватный репозиторий: GITHUB_TOKEN=... rassrochka-update
REPO_URL="$( (sudo -u rassrochka git -C "$APP_DIR" remote get-url origin 2>/dev/null) || echo https://github.com/rustem198719871987/rassrochka.git)" \
  BRANCH="$BRANCH" APP_DIR="$APP_DIR" /usr/local/bin/rassrochka-fetch-code
(cd "$APP_DIR" && sudo -u rassrochka HOME="$APP_DIR" npm ci --omit=dev --no-audit --no-fund --loglevel=error)
install -m 750 "$APP_DIR/deploy/backup.sh" /usr/local/bin/rassrochka-backup
install -m 750 "$APP_DIR/deploy/update.sh" /usr/local/bin/rassrochka-update
install -m 750 "$APP_DIR/deploy/fetch-code.sh" /usr/local/bin/rassrochka-fetch-code
systemctl restart rassrochka
sleep 3
systemctl is-active --quiet rassrochka && echo "✓ Обновлено" || { journalctl -u rassrochka -n 40 --no-pager; exit 1; }
