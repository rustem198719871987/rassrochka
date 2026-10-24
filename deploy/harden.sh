#!/usr/bin/env bash
# Защита сервера от потока запросов (DDoS на уровне приложения) и перебора паролей.
# Запускается установщиком и командой rassrochka-update; повторный запуск безопасен.
#
#  - nginx: не больше 15 запросов в секунду и 50 соединений с одного адреса, вход и регистрация —
#    10 попыток в минуту, загрузка фото — 20 в минуту; лишнее получает ответ 429;
#    таймауты против «медленных» атак (Slowloris), версия nginx скрыта;
#  - fail2ban: блокирует на 15 минут адрес, который упорно превышает лимиты, и на час — перебор пароля SSH;
#  - ufw: ограничение частоты подключений к SSH;
#  - ядро: SYN cookies и увеличенные очереди соединений;
#  - сайт слушает только 127.0.0.1 — снаружи он доступен лишь через nginx.
#
# Если новая настройка nginx не проходит проверку, прежняя возвращается без изменений.
# От мощных атак, забивающих сам канал сервера, защищает только провайдер (услуга защиты от DDoS).
set -euo pipefail
PORT="${PORT:-3000}"
SITE="${SITE:-/etc/nginx/sites-available/rassrochka}"
ENV_FILE="${ENV_FILE:-/etc/rassrochka.env}"
TEST_MODE="${TEST_MODE:-0}"

LIMITS=/etc/nginx/conf.d/rassrochka-limits.conf
PROXY=/etc/nginx/snippets/rassrochka-proxy.conf
SECURITY=/etc/nginx/snippets/rassrochka-security.conf
INCLUDE_LINE='    include snippets/rassrochka-security.conf;'

BK="$(mktemp -d)"
trap 'rm -rf "$BK"' EXIT
for f in "$LIMITS" "$PROXY" "$SECURITY" "$SITE"; do [ -f "$f" ] && cp -a "$f" "$BK/$(basename "$f")"; done
rollback() {
  for f in "$LIMITS" "$PROXY" "$SECURITY" "$SITE"; do
    if [ -f "$BK/$(basename "$f")" ]; then cp -a "$BK/$(basename "$f")" "$f"; else rm -f "$f"; fi
  done
}

mkdir -p /etc/nginx/snippets /etc/nginx/conf.d

cat > "$LIMITS" <<'EOF'
# Рассрочка.Топ: зоны ограничений (deploy/harden.sh). Подключается в блоке http.
map $request_method $rt_post_addr { POST $binary_remote_addr; default ""; }
limit_req_zone $binary_remote_addr zone=rt_req:10m rate=15r/s;
limit_req_zone $rt_post_addr zone=rt_auth:10m rate=10r/m;
limit_req_zone $binary_remote_addr zone=rt_upload:10m rate=20r/m;
limit_conn_zone $binary_remote_addr zone=rt_conn:10m;
EOF

cat > "$PROXY" <<EOF
# Рассрочка.Топ: передача запросов сайту (deploy/harden.sh)
proxy_pass http://127.0.0.1:${PORT};
proxy_http_version 1.1;
proxy_set_header Host \$host;
proxy_set_header X-Real-IP \$remote_addr;
proxy_set_header X-Forwarded-For \$remote_addr;
proxy_set_header X-Forwarded-Proto \$scheme;
proxy_read_timeout 120s;
EOF

cat > "$SECURITY" <<'EOF'
# Рассрочка.Топ: лимиты и таймауты (deploy/harden.sh). Подключается в блоке server сайта.
server_tokens off;
limit_req_status 429;
limit_conn_status 429;
limit_conn rt_conn 50;
limit_req zone=rt_req burst=100 nodelay;
client_header_timeout 15s;
client_body_timeout 60s;
send_timeout 60s;
keepalive_timeout 30s;

# вход и регистрация: перебор паролей
location ~ ^/(login|register)$ {
    limit_req zone=rt_auth burst=5 nodelay;
    limit_req zone=rt_req burst=100 nodelay;
    include snippets/rassrochka-proxy.conf;
}

# страница телефона с загрузкой фото
location ^~ /m/ {
    limit_req zone=rt_upload burst=10 nodelay;
    limit_req zone=rt_req burst=100 nodelay;
    include snippets/rassrochka-proxy.conf;
}
EOF

# подключаем лимиты в основной блок сайта (тот, где разрешена загрузка фото; блок перенаправления certbot не трогаем)
if [ -f "$SITE" ] && ! grep -q 'snippets/rassrochka-security.conf' "$SITE"; then
  sed -i "/client_max_body_size/a\\
${INCLUDE_LINE}" "$SITE"
fi

if ! nginx -t >/dev/null 2>&1; then
  nginx -t 2>&1 | tail -5 || true
  rollback
  echo "✗ Настройка nginx не прошла проверку — возвращена прежняя, сайт работает как раньше." >&2
  exit 1
fi
if [ "$TEST_MODE" != "1" ]; then systemctl reload nginx 2>/dev/null || systemctl restart nginx; fi
echo "✓ nginx: лимиты запросов и таймауты включены"

# сайт слушает только локальный адрес
if [ -f "$ENV_FILE" ] && ! grep -q '^HOST=' "$ENV_FILE"; then echo 'HOST=127.0.0.1' >> "$ENV_FILE"; fi

# ядро: защита от SYN-флуда и запас в очередях соединений
cat > /etc/sysctl.d/90-rassrochka.conf <<'EOF'
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 4096
net.core.somaxconn = 4096
EOF
if [ "$TEST_MODE" != "1" ]; then sysctl -q --system >/dev/null 2>&1 || true; fi

[ "$TEST_MODE" = "1" ] && { echo "Тестовый режим: fail2ban и ufw пропущены"; exit 0; }

# SSH: не больше 6 подключений за 30 секунд с одного адреса
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw limit OpenSSH >/dev/null 2>&1 || true
fi

# fail2ban: блокировка адресов, которые упорно превышают лимиты или подбирают пароль SSH
if ! command -v fail2ban-client >/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban >/dev/null 2>&1 || echo "! fail2ban не установился — остальная защита работает"
fi
if command -v fail2ban-client >/dev/null; then
  cat > /etc/fail2ban/jail.d/rassrochka.conf <<'EOF'
# Рассрочка.Топ (deploy/harden.sh)
[sshd]
enabled = true
maxretry = 6
findtime = 10m
bantime = 1h

[nginx-limit-req]
enabled = true
port = http,https
logpath = /var/log/nginx/error.log
findtime = 1m
maxretry = 60
bantime = 15m
EOF
  systemctl enable -q fail2ban >/dev/null 2>&1 || true
  if systemctl restart fail2ban; then echo "✓ fail2ban: блокировка нарушителей включена"; else echo "! fail2ban не запустился — остальная защита работает"; fi
fi
