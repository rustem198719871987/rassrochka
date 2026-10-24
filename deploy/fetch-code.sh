#!/usr/bin/env bash
# Скачивает код сайта в /opt/rassrochka. Устанавливается как /usr/local/bin/rassrochka-fetch-code.
#
# С российских серверов GitHub часто обрывает большие загрузки (git clone, архив), а мелкие запросы
# проходят. Поэтому код качается по одному файлу и только те файлы, что изменились: каждый с повторами,
# с raw.githubusercontent.com или, если он не отвечает, с зеркала cdn.jsdelivr.net. Каждый файл
# сверяется с контрольной суммой из GitHub, так что подменить код через зеркало нельзя.
# Код в APP_DIR меняется только после того, как всё скачано и проверено. Данные сайта не затрагиваются.
set -euo pipefail
REPO_URL="${REPO_URL:-https://github.com/rustem198719871987/rassrochka.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/rassrochka}"
APP_USER="${APP_USER:-rassrochka}"

OWNER_REPO="$(printf '%s' "$REPO_URL" | sed -E 's#^https://github.com/##; s#\.git$##')"
AUTH=()
AUTH_URL="$REPO_URL"
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: token ${GITHUB_TOKEN}")
  AUTH_URL="${REPO_URL/https:\/\//https://x-access-token:${GITHUB_TOKEN}@}"
fi
# короткие запросы: обрыв или зависание — сразу повтор
CURL=(curl -fsSL --connect-timeout 10 --max-time 60 --retry 4 --retry-delay 2 --retry-all-errors)
# сюда не заходим: библиотеки, данные, настройки
KEEP='^(node_modules|\.npm|\.npmrc|\.git|\.version|data|\.env)(/|$)'

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1. Номер последней версии (коммита)
echo "Узнаю последнюю версию…"
SHA="$("${CURL[@]}" "${AUTH[@]}" -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/${OWNER_REPO}/commits/${BRANCH}" 2>/dev/null || true)"
if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  SHA="$(timeout 30 git ls-remote "$AUTH_URL" "refs/heads/${BRANCH}" 2>/dev/null </dev/null | cut -f1 || true)"
fi
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "✗ GitHub не ответил: не удалось узнать последнюю версию. Попробуйте через пару минут." >&2; exit 1; }

# 2. Список файлов с контрольными суммами: «алгоритм  сумма  права  путь»
LIST="$TMP/list"
if "${CURL[@]}" "${AUTH[@]}" "https://api.github.com/repos/${OWNER_REPO}/git/trees/${SHA}?recursive=1" -o "$TMP/tree.json" 2>/dev/null; then
  node -e '
    const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (t.truncated) process.exit(2);
    for (const e of t.tree) if (e.type === "blob" && e.mode !== "120000") console.log(["git", e.sha, e.mode, e.path].join("\t"));
  ' "$TMP/tree.json" > "$LIST"
elif [ -z "${GITHUB_TOKEN:-}" ] && "${CURL[@]}" "https://data.jsdelivr.com/v1/packages/gh/${OWNER_REPO}@${SHA}?structure=flat" -o "$TMP/tree.json" 2>/dev/null; then
  # запасной список с зеркала: sha256 в base64, права не передаются — исполняемыми делаем *.sh
  node -e '
    const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const f of t.files) { const p = f.name.replace(/^\//, ""); console.log(["sha256", f.hash, p.endsWith(".sh") ? "100755" : "100644", p].join("\t")); }
  ' "$TMP/tree.json" > "$LIST"
fi
[ -s "$LIST" ] && grep -q $'\tserver.js$' "$LIST" || { echo "✗ GitHub не отдал список файлов. Попробуйте через пару минут." >&2; exit 1; }

sum_of() { # алгоритм файл
  if [ "$1" = "git" ]; then git hash-object --no-filters "$2"; else openssl dgst -sha256 -binary "$2" | base64; fi
}

# 3. Какие файлы изменились
: > "$TMP/todo"
while IFS=$'\t' read -r algo sum mode path; do
  [[ "$path" =~ $KEEP ]] && continue
  if [ ! -f "$APP_DIR/$path" ] || [ "$(sum_of "$algo" "$APP_DIR/$path")" != "$sum" ]; then
    printf '%s\t%s\t%s\n' "$algo" "$sum" "$path" >> "$TMP/todo"
  fi
done < "$LIST"
CHANGED="$(wc -l < "$TMP/todo")"
echo "Версия ${SHA:0:7}: изменённых файлов — ${CHANGED}"

# 4. Скачиваем изменённые файлы (по 6 одновременно) и сверяем суммы
NEW="$TMP/new"
mkdir -p "$NEW"
chmod 755 "$NEW"
export SHA OWNER_REPO NEW
export -f sum_of
fetch_one() {
  local algo="$1" sum="$2" path="$3" url out="$NEW/$3" auth=()
  [ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: token ${GITHUB_TOKEN}")
  mkdir -p "$(dirname "$out")"
  for url in "https://raw.githubusercontent.com/${OWNER_REPO}/${SHA}/${path// /%20}" \
             "https://cdn.jsdelivr.net/gh/${OWNER_REPO}@${SHA}/${path// /%20}"; do
    if curl -fsSL --connect-timeout 10 --max-time 60 --retry 4 --retry-delay 2 --retry-all-errors \
         "${auth[@]}" "$url" -o "$out" 2>/dev/null \
       && [ "$(sum_of "$algo" "$out")" = "$sum" ]; then
      return 0
    fi
    [ -n "${GITHUB_TOKEN:-}" ] && break # приватный репозиторий на зеркале недоступен
  done
  echo "✗ Не скачался файл ${path}" >&2
  return 1
}
export -f fetch_one
export GITHUB_TOKEN="${GITHUB_TOKEN:-}"
if [ "$CHANGED" -gt 0 ]; then
  tr '\n' '\0' < "$TMP/todo" | xargs -0 -P 6 -I{} bash -c 'IFS=$'"'"'\t'"'"' read -r a s p <<< "$1"; fetch_one "$a" "$s" "$p"' _ {} \
    || { echo "✗ Часть файлов не скачалась, код сайта не тронут. Запустите обновление ещё раз." >&2; exit 1; }
fi

# 5. Всё скачано — заменяем изменённые файлы и убираем удалённые из репозитория
if [ "$CHANGED" -gt 0 ]; then cp -a "$NEW/." "$APP_DIR/"; fi
while IFS=$'\t' read -r _ _ mode path; do
  [[ "$path" =~ $KEEP ]] && continue
  if [ "$mode" = "100755" ]; then chmod 755 "$APP_DIR/$path"; else chmod 644 "$APP_DIR/$path"; fi
done < "$LIST"
cut -f4 "$LIST" | sort > "$TMP/want"
(cd "$APP_DIR" && find . \( -path ./node_modules -o -path ./.git -o -path ./data \) -prune -o -type f -print \
  | sed 's#^\./##' | { grep -Ev "$KEEP" || true; } | sort) > "$TMP/have"
comm -13 "$TMP/want" "$TMP/have" | while IFS= read -r f; do
  rm -f "$APP_DIR/$f"
  rmdir -p --ignore-fail-on-non-empty "$(dirname "$APP_DIR/$f")" 2>/dev/null || true
done
echo "$SHA" > "$APP_DIR/.version"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
echo "Код обновлён до версии ${SHA:0:7}"
