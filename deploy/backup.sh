#!/usr/bin/env bash
# Резервная копия базы и загруженных файлов. Запускается по расписанию из /etc/cron.d/rassrochka-backup.
# Файлы в uploads зашифрованы; ключ (FILES_KEY в /etc/rassrochka.env) в копию не входит — храните его отдельно.
set -euo pipefail
DATA_DIR="${DATA_DIR:-/var/lib/rassrochka}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/rassrochka}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y-%m-%d_%H%M)"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
# .backup делает согласованную копию даже во время работы сайта
sqlite3 "$DATA_DIR/app.db" ".backup '$BACKUP_DIR/app-$STAMP.db'"
if [ -d "$DATA_DIR/uploads" ]; then
  tar -czf "$BACKUP_DIR/uploads-$STAMP.tar.gz" -C "$DATA_DIR" uploads
fi
chmod 600 "$BACKUP_DIR"/*"$STAMP"* 2>/dev/null || true
find "$BACKUP_DIR" -type f -mtime "+$KEEP_DAYS" -delete
echo "$(date '+%F %T') копия $STAMP: $(du -sh "$BACKUP_DIR" | cut -f1) в $BACKUP_DIR"
