// Автоматическая проверка клиента в банке данных исполнительных производств ФССП.
//
// Официальный API ФССП отключён с 2022 года, а сайт fssp.gov.ru закрыт капчей от программ —
// обходить её мы не стали. Автоматизация идёт законным путём: через поставщика данных
// (он получает сведения ФССП по договору и отдаёт их по API за небольшую плату за запрос).
//
//  - api-cloud — api-cloud.ru: ключ (token) из личного кабинета, вводится в Настройках;
//  - custom — свой адрес FSSP_API_URL в /etc/rassrochka.env (POST JSON, ответ { found, details }).
//
// Ответ поставщика разбирается осторожно: если формат не распознан, проверка считается
// не выполненной (а не «долгов нет»), и продавец видит, что нужно проверить вручную.
const { getSecret } = require('./db');

const PROVIDERS = { 'api-cloud': 'api-cloud.ru' };
const provider = () => {
  if (process.env.FSSP_API_URL) return 'custom';
  const p = getSecret('fssp_provider');
  return PROVIDERS[p] && getSecret('fssp_token') ? p : null;
};
const configured = () => Boolean(provider());

const ruDate = (iso) => String(iso || '').split('-').reverse().join('.');
const money = (v) => {
  const m = String(v ?? '').replace(/\s/g, '').replace(',', '.').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
};

// Повторная проверка того же человека в течение 6 часов не тратит деньги на запрос
const cache = new Map();
const CACHE_MS = 6 * 3600e3;

// Ищет в ответе массив записей об исполнительных производствах (у поставщиков он лежит под разными ключами)
const RECORD_KEYS = ['name', 'debtor', 'debtor_name', 'exe_production', 'ip', 'number', 'ip_number', 'subject', 'details'];
function findRecords(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 5) return null;
  if (Array.isArray(node)) {
    if (!node.length) return null;
    if (node.every((x) => x && typeof x === 'object' && !Array.isArray(x) && RECORD_KEYS.some((k) => k in x))) return node;
    for (const x of node) { const r = findRecords(x, depth + 1); if (r) return r; }
    return null;
  }
  for (const v of Object.values(node)) { const r = findRecords(v, depth + 1); if (r) return r; }
  return null;
}
function emptyResultMarker(data) {
  // явный признак «ничего не найдено»: count = 0 или пустые массивы результатов
  const counts = ['count', 'total', 'records_count', 'countAll'].map((k) => data[k]).filter((v) => v !== undefined);
  if (counts.length && counts.every((v) => Number(v) === 0)) return true;
  const arrays = ['records', 'result', 'results', 'rows', 'items', 'data'].map((k) => data[k]);
  return arrays.some((v) => Array.isArray(v) && v.length === 0);
}

function summarize(records) {
  const pick = (r, keys) => { for (const k of keys) if (r[k] != null && r[k] !== '') return r[k]; return ''; };
  const active = records.filter((r) => !pick(r, ['ip_end', 'end', 'end_reason', 'reason_end', 'ip_end_date', 'date_end']));
  let sum = 0;
  const lines = active.slice(0, 3).map((r) => {
    const subject = String(pick(r, ['subject', 'predmet', 'details', 'sum', 'amount']));
    const amount = money(pick(r, ['sum', 'amount', 'debt', 'total'])) || money(subject);
    sum += amount;
    const num = pick(r, ['exe_production', 'ip_number', 'number', 'ip']);
    return [String(num).split(/[ ,]/)[0], subject.slice(0, 120)].filter(Boolean).join(' — ');
  });
  for (const r of active.slice(3)) sum += money(pick(r, ['sum', 'amount', 'debt', 'total'])) || money(pick(r, ['subject', 'details']));
  return { active: active.length, closed: records.length - active.length, sum: Math.round(sum * 100) / 100, lines };
}

async function apiCloud(a) {
  const url = new URL('https://api-cloud.ru/api/fssp.php');
  url.searchParams.set('type', 'physical');
  url.searchParams.set('lastname', a.last_name || '');
  url.searchParams.set('firstname', a.first_name || '');
  if (a.middle_name) url.searchParams.set('secondname', a.middle_name);
  url.searchParams.set('birthdate', ruDate(a.birth_date));
  url.searchParams.set('region', getSecret('fssp_region') || '-1');
  url.searchParams.set('token', getSecret('fssp_token'));
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`поставщик ответил не JSON (HTTP ${res.status})`); }
  return { data, raw: text, httpOk: res.ok };
}

async function custom(a) {
  const res = await fetch(process.env.FSSP_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.FSSP_API_TOKEN || ''}` },
    body: JSON.stringify({
      last_name: a.last_name, first_name: a.first_name, middle_name: a.middle_name, birth_date: a.birth_date,
      passport_series: a.passport_series, passport_number: a.passport_number, reg_address: a.reg_address,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`поставщик ответил не JSON (HTTP ${res.status})`); }
  return { data, raw: text, httpOk: res.ok };
}

// Разбор ответа: { status: 'ok' | 'hit' | 'error', details, raw }
function interpret({ data, raw, httpOk }) {
  if (data && typeof data.found === 'boolean') {
    return { status: data.found ? 'hit' : 'ok', details: data.details || (data.found ? 'Найдены исполнительные производства' : 'Исполнительных производств не найдено'), raw };
  }
  const err = data && (data.error || data.errormsg || data.message || data.exception
    || (String(data.status).toLowerCase() === 'error' && 'ошибка поставщика'));
  if (!httpOk || (err && !findRecords(data))) {
    return { status: 'error', details: `Поставщик данных вернул ошибку: ${String(err || 'HTTP-ошибка').slice(0, 200)}`, raw };
  }
  const records = findRecords(data);
  if (records) {
    const s = summarize(records);
    if (!s.active) return { status: 'ok', details: `Действующих производств нет${s.closed ? ` (оконченных: ${s.closed})` : ''}`, raw };
    return {
      status: 'hit',
      details: `Действующих исполнительных производств: ${s.active}${s.sum ? `, сумма ≈ ${s.sum.toLocaleString('ru-RU')} ₽` : ''}. ${s.lines.join('; ')}`,
      raw,
    };
  }
  if (data && typeof data === 'object' && emptyResultMarker(data)) return { status: 'ok', details: 'Исполнительных производств не найдено', raw };
  return { status: 'error', details: 'Ответ поставщика данных не распознан — проверьте клиента вручную и сообщите разработчику', raw };
}

async function check(a, { useCache = true } = {}) {
  const p = provider();
  if (!p) return { status: 'not_configured', details: 'Автоматическая проверка не подключена' };
  const key = [a.last_name, a.first_name, a.middle_name, a.birth_date].map((x) => String(x || '').toLowerCase().trim()).join('|');
  const hit = useCache && cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  let result;
  try {
    result = interpret(await (p === 'custom' ? custom(a) : apiCloud(a)));
  } catch (e) {
    result = { status: 'error', details: `Не удалось проверить: ${e.name === 'TimeoutError' ? 'поставщик не ответил за минуту' : e.message}` };
  }
  result.details = `${result.details} (${p === 'custom' ? 'поставщик данных' : PROVIDERS[p]})`;
  if (result.status !== 'error') cache.set(key, { at: Date.now(), result });
  for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k);
  return result;
}

module.exports = { check, configured, provider, interpret, PROVIDERS };
