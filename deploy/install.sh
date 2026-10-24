#!/usr/bin/env bash
# Установка «Рассрочка.Топ» на чистый сервер Ubuntu 22.04 / 24.04 одной командой.
# Повторный запуск безопасен: обновит код и настройки, данные и ключи сохранятся.
#
#   DOMAIN=rassrochka.top EMAIL=you@mail.ru bash install.sh   — с доменом и HTTPS
#   bash install.sh                                            — по IP-адресу, без HTTPS
#
# Переменные (все необязательные):
#   DOMAIN        домен сайта (A-запись должна указывать на этот сервер) — включает HTTPS
#   EMAIL         почта для Let's Encrypt (уведомления об окончании сертификата)
#   REPO_URL      репозиторий (по умолчанию GitHub rustem198719871987/rassrochka)
#   GITHUB_TOKEN  токен, если репозиторий приватный
#   BRANCH        ветка (main)
#   ADMIN_PHONE   телефон администратора (79990000000)
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/rustem198719871987/rassrochka.git}"
BRANCH="${BRANCH:-main}"
APP_USER=rassrochka
APP_DIR=/opt/rassrochka
DATA_DIR=/var/lib/rassrochka
BACKUP_DIR=/var/backups/rassrochka
ENV_FILE=/etc/rassrochka.env
PORT=3000
NODE_MAJOR=22
# TEST_MODE=1 — для проверки скрипта в контейнере без systemd: службы не запускаются
TEST_MODE="${TEST_MODE:-0}"

log() { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запустите от root (или через sudo)"
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || die "Скрипт рассчитан на Ubuntu, а здесь ${PRETTY_NAME:-неизвестная система}"

export DEBIAN_FRONTEND=noninteractive

# домен уже подключён раньше — берём его из настроек, чтобы повторный запуск не выключил HTTPS
if [ -z "${DOMAIN:-}" ] && [ -f "$ENV_FILE" ]; then
  DOMAIN="$(sed -n 's#^PUBLIC_URL=https://\([^/]*\).*#\1#p' "$ENV_FILE")"
fi

log "Системные пакеты"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git nginx sqlite3 build-essential python3 ufw openssl >/dev/null
if [ -n "${DOMAIN:-}" ]; then apt-get install -y -qq certbot python3-certbot-nginx >/dev/null; fi

log "Node.js ${NODE_MAJOR}"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

log "Пользователь и папки"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_DIR"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$DATA_DIR"
install -d -o root -g root -m 700 "$BACKUP_DIR"

log "Код сайта"
# загрузчик кода (он же используется командой rassrochka-update): из этой папки, если установщик
# запущен из уже скачанного кода, иначе — с GitHub или его зеркала
FETCH=/usr/local/bin/rassrochka-fetch-code
OWNER_REPO="$(printf '%s' "$REPO_URL" | sed -E 's#^https://github.com/##; s#\.git$##')"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -f "$SELF_DIR/fetch-code.sh" ] && [ -f "$SELF_DIR/install.sh" ]; then
  install -m 750 "$SELF_DIR/fetch-code.sh" "$FETCH"
else
  got=""
  CURL_AUTH=()
  if [ -n "${GITHUB_TOKEN:-}" ]; then CURL_AUTH=(-H "Authorization: token ${GITHUB_TOKEN}"); fi
  for url in "https://raw.githubusercontent.com/${OWNER_REPO}/${BRANCH}/deploy/fetch-code.sh" \
             "https://cdn.jsdelivr.net/gh/${OWNER_REPO}@${BRANCH}/deploy/fetch-code.sh"; do
    if curl -fsSL --connect-timeout 10 --max-time 60 --retry 4 --retry-delay 2 --retry-all-errors \
         "${CURL_AUTH[@]}" "$url" -o "$FETCH.tmp" \
       && head -1 "$FETCH.tmp" | grep -q '^#!/usr/bin/env bash'; then got=1; break; fi
  done
  [ -n "$got" ] || die "Не удалось скачать загрузчик кода с GitHub. Попробуйте через пару минут."
  mv "$FETCH.tmp" "$FETCH"
fi
chmod 750 "$FETCH"
# SKIP_CODE=1 — оставить уже установленный код (например, только подключить домен, если GitHub не отвечает)
if [ "${SKIP_CODE:-0}" = "1" ] && [ -f "$APP_DIR/server.js" ]; then
  echo "Код не скачиваю (SKIP_CODE=1), оставляю установленный"
else
  REPO_URL="$REPO_URL" BRANCH="$BRANCH" APP_DIR="$APP_DIR" APP_USER="$APP_USER" GITHUB_TOKEN="${GITHUB_TOKEN:-}" "$FETCH"

  log "Зависимости"
  (cd "$APP_DIR" && sudo -u "$APP_USER" HOME="$APP_DIR" npm ci --omit=dev --no-audit --no-fund --loglevel=error)
fi

log "Настройки (${ENV_FILE})"
if [ ! -f "$ENV_FILE" ]; then
  NEW_ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 14)"
  cat > "$ENV_FILE" <<EOF
# Настройки Рассрочка.Топ. После изменения: systemctl restart rassrochka
PORT=${PORT}
DATA_DIR=${DATA_DIR}
SESSION_SECRET=$(openssl rand -hex 48)
# Ключ шифрования файлов. СОХРАНИТЕ ЕГО КОПИЮ ОТДЕЛЬНО: без него сканы и фото паспортов не восстановить
FILES_KEY=$(openssl rand -hex 32)
ADMIN_PHONE=${ADMIN_PHONE:-79990000000}
ADMIN_PASSWORD=${NEW_ADMIN_PASSWORD}
COOKIE_SECURE=0
PUBLIC_URL=
JOBS=on
TZ_DISPLAY=Europe/Moscow
EOF
fi
chown root:"$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"
# пароль остаётся в файле до первого успешного запуска — показываем его и при повторной установке
NEW_ADMIN_PASSWORD="$(grep '^ADMIN_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"

SERVER_IP="$(curl -fsS -4 --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
if [ -n "${DOMAIN:-}" ]; then SITE_URL="https://${DOMAIN}"; else SITE_URL="http://${SERVER_IP}"; fi
sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=${SITE_URL}#" "$ENV_FILE"

log "Служба systemd"
NODE_BIN="$(command -v node)"
cat > /etc/systemd/system/rassrochka.service <<EOF
[Unit]
Description=Рассрочка.Топ
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
Environment=NODE_ENV=production
ExecStart=${NODE_BIN} server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

log "Nginx"
# IPv6 на некоторых серверах выключен — тогда nginx не должен его слушать
LISTEN_V6=""
if [ -s /proc/net/if_inet6 ]; then LISTEN_V6="listen [::]:80;"; fi
cat > /etc/nginx/sites-available/rassrochka <<EOF
server {
    listen 80;
    ${LISTEN_V6}
    server_name ${DOMAIN:-_};

    # фото паспорта и сканы договора с телефона
    client_max_body_size 60m;

    add_header X-Content-Type-Options nosniff always;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
EOF
ln -sf /etc/nginx/sites-available/rassrochka /etc/nginx/sites-enabled/rassrochka
rm -f /etc/nginx/sites-enabled/default
nginx -t

log "Резервные копии (каждую ночь в 03:30, хранятся 14 дней)"
install -m 750 "$APP_DIR/deploy/backup.sh" /usr/local/bin/rassrochka-backup
install -m 750 "$APP_DIR/deploy/update.sh" /usr/local/bin/rassrochka-update
echo "30 3 * * * root /usr/local/bin/rassrochka-backup >> /var/log/rassrochka-backup.log 2>&1" > /etc/cron.d/rassrochka-backup
chmod 644 /etc/cron.d/rassrochka-backup

if [ "$TEST_MODE" = "1" ]; then
  log "Тестовый режим: службы, файрвол и HTTPS пропущены"
else
  log "Запуск"
  systemctl daemon-reload
  systemctl enable -q rassrochka
  systemctl restart rassrochka
  systemctl reload nginx || systemctl restart nginx

  log "Файрвол: открыты только SSH, HTTP и HTTPS"
  ufw allow OpenSSH >/dev/null
  ufw allow 'Nginx Full' >/dev/null
  ufw --force enable >/dev/null

  if [ -n "${DOMAIN:-}" ]; then
    log "HTTPS-сертификат для ${DOMAIN}"
    if [ -n "${EMAIL:-}" ]; then CERT_MAIL=(-m "$EMAIL"); else CERT_MAIL=(--register-unsafely-without-email); fi
    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect "${CERT_MAIL[@]}"; then
      sed -i 's#^COOKIE_SECURE=.*#COOKIE_SECURE=1#' "$ENV_FILE"
      systemctl restart rassrochka
    else
      echo "Сертификат не получен. Проверьте, что A-запись ${DOMAIN} указывает на ${SERVER_IP}, и запустите скрипт ещё раз."
      SITE_URL="http://${DOMAIN}"
    fi
  fi

  log "Проверка"
  for i in $(seq 1 20); do
    if curl -fs -o /dev/null "http://127.0.0.1:${PORT}/login"; then break; fi
    sleep 1
  done
  curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/login" || { journalctl -u rassrochka -n 40 --no-pager; die "Сайт не запустился — журнал выше"; }
fi

# пароль нужен только для создания администратора при первом запуске — в файле его не оставляем
if [ -n "$NEW_ADMIN_PASSWORD" ] && [ "$TEST_MODE" != "1" ]; then sed -i 's#^ADMIN_PASSWORD=.*#ADMIN_PASSWORD=#' "$ENV_FILE"; fi

printf '\n\033[1;32m✓ Готово\033[0m\n'
echo "Сайт:            ${SITE_URL}"
if [ -n "$NEW_ADMIN_PASSWORD" ]; then
  echo "Администратор:   +$(grep '^ADMIN_PHONE=' "$ENV_FILE" | cut -d= -f2)"
  echo "Пароль:          ${NEW_ADMIN_PASSWORD}   ← сохраните и смените после входа (Настройки)"
fi
echo "Ключ шифрования файлов хранится в ${ENV_FILE} (FILES_KEY) — сохраните его копию в надёжном месте."
echo "Обновить сайт:   rassrochka-update"
echo "Журнал:          journalctl -u rassrochka -f"
if [ -z "${DOMAIN:-}" ]; then
  echo
  echo "ВНИМАНИЕ: сайт работает без HTTPS. Не вводите реальные паспортные данные, пока не подключите домен:"
  echo "  DOMAIN=ваш-домен.ru EMAIL=почта bash ${APP_DIR}/deploy/install.sh"
fi
