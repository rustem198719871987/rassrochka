#!/usr/bin/env bash
# Почта для выписок банка: Postfix принимает письма только для rustem@ДОМЕН и кладёт их
# в DATA_DIR/mail/inbox — оттуда их каждые 2 минуты забирает сайт (lib/mailbox.js).
# Сервер не пересылает почту наружу (не «открытый релей») и других адресов не принимает.
# От спама: проверка HELO и домена отправителя, чёрные списки Spamhaus и SpamCop, лимиты частоты,
# fail2ban; дальше сайт принимает только письма разрешённых адресов банка с подтверждённой подписью.
# Запускается установщиком и командой rassrochka-update; повторный запуск безопасен.
# Нужна MX-запись домена, указывающая на этот сервер (см. README).
set -euo pipefail
ENV_FILE="${ENV_FILE:-/etc/rassrochka.env}"
DATA_DIR="${DATA_DIR:-/var/lib/rassrochka}"
APP_USER="${APP_USER:-rassrochka}"
MAIL_USER="${MAIL_USER:-rustem}"
TEST_MODE="${TEST_MODE:-0}"

DOMAIN="${DOMAIN:-$(sed -n 's#^PUBLIC_URL=https\?://\([^/:]*\).*#\1#p' "$ENV_FILE" 2>/dev/null || true)}"
if [ -z "$DOMAIN" ] || [[ "$DOMAIN" =~ ^[0-9.]+$ ]]; then
  echo "Почта для выписок: домен не подключён — пропускаю"
  exit 0
fi

if ! command -v postconf >/dev/null; then
  echo "postfix postfix/main_mailer_type select No configuration" | debconf-set-selections
  echo "postfix postfix/mailname string ${DOMAIN}" | debconf-set-selections
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postfix >/dev/null
fi
[ -f /etc/postfix/main.cf ] || cp /usr/share/postfix/main.cf.debian /etc/postfix/main.cf

install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$DATA_DIR/mail"
echo "${MAIL_USER}@${DOMAIN}    inbox/" > /etc/postfix/rassrochka-mailboxes
postmap /etc/postfix/rassrochka-mailboxes

postconf -e \
  "myhostname = ${DOMAIN}" "mydomain = ${DOMAIN}" "myorigin = ${DOMAIN}" \
  "mydestination = localhost" "mynetworks = 127.0.0.0/8" "relayhost =" \
  "inet_interfaces = all" "inet_protocols = ipv4" \
  "virtual_mailbox_domains = ${DOMAIN}" \
  "virtual_mailbox_base = ${DATA_DIR}/mail" \
  "virtual_mailbox_maps = hash:/etc/postfix/rassrochka-mailboxes" \
  "virtual_uid_maps = static:$(id -u "$APP_USER")" "virtual_gid_maps = static:$(id -g "$APP_USER")" "virtual_minimum_uid = 100" \
  "virtual_mailbox_limit = 104857600" "message_size_limit = 26214400" \
  "smtpd_relay_restrictions = permit_mynetworks, reject_unauth_destination" \
  "smtpd_helo_required = yes" "disable_vrfy_command = yes" "smtpd_banner = \$myhostname ESMTP" \
  "smtpd_helo_restrictions = permit_mynetworks, reject_invalid_helo_hostname, reject_non_fqdn_helo_hostname" \
  "smtpd_sender_restrictions = permit_mynetworks, reject_non_fqdn_sender, reject_unknown_sender_domain" \
  "smtpd_recipient_restrictions = permit_mynetworks, reject_unauth_pipelining, reject_non_fqdn_recipient, reject_unknown_recipient_domain, reject_unauth_destination, reject_rbl_client zen.spamhaus.org=127.0.0.[2..11], reject_rbl_client bl.spamcop.net" \
  "smtpd_data_restrictions = reject_unauth_pipelining" "smtpd_reject_unlisted_recipient = yes" \
  "smtpd_client_connection_rate_limit = 30" "smtpd_client_message_rate_limit = 60" "anvil_rate_time_unit = 60s" \
  "biff = no" "append_dot_mydomain = no"

# шифрование при приёме (STARTTLS) — тем же сертификатом Let's Encrypt, что и сайт
CERT="/etc/letsencrypt/live/${DOMAIN}"
if [ -f "$CERT/fullchain.pem" ]; then
  postconf -e "smtpd_tls_cert_file = $CERT/fullchain.pem" "smtpd_tls_key_file = $CERT/privkey.pem" \
    "smtpd_tls_security_level = may" "smtpd_tls_protocols = !SSLv2, !SSLv3, !TLSv1, !TLSv1.1"
  mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  printf '#!/bin/sh\nsystemctl reload postfix\n' > /etc/letsencrypt/renewal-hooks/deploy/rassrochka-postfix.sh
  chmod 755 /etc/letsencrypt/renewal-hooks/deploy/rassrochka-postfix.sh
fi

# fail2ban: адреса, которые снова и снова получают отказ (спам, перебор адресов), блокируются на час
# (журнал читается из systemd, а если модуля для него нет — из /var/log/mail.log; иначе правило не включаем,
#  чтобы не сломать остальные правила fail2ban)
if [ "$TEST_MODE" != "1" ] && command -v fail2ban-client >/dev/null; then
  BACKEND=""
  if python3 -c 'import systemd.journal' 2>/dev/null; then BACKEND="backend = systemd"
  elif [ -f /var/log/mail.log ]; then BACKEND="logpath = /var/log/mail.log"; fi
  if [ -n "$BACKEND" ]; then
    printf '%s\n' '# Рассрочка.Топ (deploy/mail.sh)' '[postfix]' 'enabled = true' "$BACKEND" 'mode = aggressive' \
      'maxretry = 5' 'findtime = 10m' 'bantime = 1h' > /etc/fail2ban/jail.d/rassrochka-mail.conf
    if ! fail2ban-client -t >/dev/null 2>&1; then rm -f /etc/fail2ban/jail.d/rassrochka-mail.conf; fi
    systemctl restart fail2ban >/dev/null 2>&1 || true
  fi
fi

postfix check
if [ "$TEST_MODE" = "1" ]; then
  postfix status >/dev/null 2>&1 && postfix reload >/dev/null 2>&1 || postfix start >/dev/null 2>&1
else
  systemctl enable -q postfix
  systemctl restart postfix
  if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then ufw allow 25/tcp >/dev/null; fi
fi

echo "${MAIL_USER}@${DOMAIN}" > "$DATA_DIR/mail/.address"
chown "$APP_USER":"$APP_USER" "$DATA_DIR/mail/.address"
echo "✓ Почта для выписок: ${MAIL_USER}@${DOMAIN}"
