#!/usr/bin/env bash
# Скачивает код сайта в /opt/rassrochka: сначала через git, а если GitHub по git не отвечает
# (бывает с российских серверов) — архивом с codeload.github.com. Данные сайта не затрагиваются.
set -euo pipefail
REPO_URL="${REPO_URL:-https://github.com/rustem198719871987/rassrochka.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/rassrochka}"
APP_USER="${APP_USER:-rassrochka}"
GIT_WAIT="${GIT_WAIT:-120}"

OWNER_REPO="$(printf '%s' "$REPO_URL" | sed -E 's#^https://github.com/##; s#\.git$##')"
AUTH_URL="$REPO_URL"
CURL_AUTH=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH_URL="${REPO_URL/https:\/\//https://x-access-token:${GITHUB_TOKEN}@}"
  CURL_AUTH=(-H "Authorization: token ${GITHUB_TOKEN}")
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
chown "$APP_USER" "$TMP"
SRC="$TMP/src"
# git обрывается, если скорость ниже 1 КБ/с дольше 20 секунд, и в любом случае через GIT_WAIT секунд
GIT_OPTS=(-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20)

got=""
if [ "${FORCE_ARCHIVE:-0}" != "1" ]; then
  echo "Скачиваю через git…"
  if timeout "$GIT_WAIT" sudo -u "$APP_USER" git "${GIT_OPTS[@]}" clone -q --depth 50 --branch "$BRANCH" "$AUTH_URL" "$SRC" </dev/null; then
    sudo -u "$APP_USER" git -C "$SRC" remote set-url origin "$REPO_URL"
    got="git"
  else
    echo "GitHub не ответил по git за ${GIT_WAIT} сек."
    rm -rf "$SRC"
  fi
fi

if [ -z "$got" ]; then
  echo "Скачиваю архивом…"
  for url in "https://codeload.github.com/${OWNER_REPO}/tar.gz/refs/heads/${BRANCH}" \
             "https://github.com/${OWNER_REPO}/archive/refs/heads/${BRANCH}.tar.gz"; do
    if curl -fsSL --retry 3 --connect-timeout 20 --max-time 300 "${CURL_AUTH[@]}" "$url" -o "$TMP/code.tgz"; then
      mkdir -p "$SRC"
      tar -xzf "$TMP/code.tgz" -C "$SRC" --strip-components=1
      got="archive"
      break
    fi
  done
fi
[ -n "$got" ] || { echo "✗ Не удалось скачать код ни через git, ни архивом. Проверьте доступ к github.com с сервера." >&2; exit 1; }
[ -f "$SRC/server.js" ] || { echo "✗ В скачанном коде нет server.js" >&2; exit 1; }

# заменяем код, сохраняя установленные библиотеки (их обновит npm ci)
find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .npm ! -name .npmrc -exec rm -rf {} +
cp -a "$SRC/." "$APP_DIR/"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  echo "Версия: $(sudo -u "$APP_USER" git -C "$APP_DIR" log --oneline -1)"
else
  echo "Версия: архив ветки ${BRANCH} от $(date '+%d.%m.%Y %H:%M')"
fi
