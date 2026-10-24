#!/usr/bin/env bash
# Обновление сайта до последней версии из GitHub: копия базы → новый код → перезапуск.
# Качаются только изменённые файлы; библиотеки переустанавливаются, только если поменялся их список.
set -euo pipefail
APP_DIR=/opt/rassrochka
BRANCH="${BRANCH:-main}"

/usr/local/bin/rassrochka-backup
lock_sum() { sha256sum "$APP_DIR/package-lock.json" 2>/dev/null | cut -d' ' -f1 || true; }
OLD_LOCK="$(lock_sum)"
# Приватный репозиторий: GITHUB_TOKEN=... rassrochka-update
REPO_URL="$( (sudo -u rassrochka git -C "$APP_DIR" remote get-url origin 2>/dev/null) || echo https://github.com/rustem198719871987/rassrochka.git)" \
  BRANCH="$BRANCH" APP_DIR="$APP_DIR" /usr/local/bin/rassrochka-fetch-code
if [ "$OLD_LOCK" != "$(lock_sum)" ] || [ ! -d "$APP_DIR/node_modules" ]; then
  echo "Обновляю библиотеки…"
  (cd "$APP_DIR" && sudo -u rassrochka HOME="$APP_DIR" npm ci --omit=dev --no-audit --no-fund --loglevel=error)
fi
install -m 750 "$APP_DIR/deploy/backup.sh" /usr/local/bin/rassrochka-backup
install -m 750 "$APP_DIR/deploy/update.sh" /usr/local/bin/rassrochka-update
install -m 750 "$APP_DIR/deploy/fetch-code.sh" /usr/local/bin/rassrochka-fetch-code
systemctl restart rassrochka
sleep 3
systemctl is-active --quiet rassrochka && echo "✓ Обновлено" || { journalctl -u rassrochka -n 40 --no-pager; exit 1; }
