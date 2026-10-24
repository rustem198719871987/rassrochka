// Проверка клиента по базам перед выдачей рассрочки.
//
// 1. Внутренний стоп-лист — ведёт администратор (работает сразу).
// 2. Внутренняя история — просрочки клиента по прошлым рассрочкам в этой системе.
// 3. ФССП (исполнительные производства) — через внешнего поставщика данных.
// 4. Банковские стоп-листы / кредитная история (БКИ) — через внешнего поставщика.
//
// ФССП проверяется автоматически через поставщика данных (lib/fssp.js, ключ — в Настройках).
// Пока он не подключён или не ответил, продавец проверяет клиента вручную на fssp.gov.ru.
// БКИ — адаптер к поставщику, с которым заключён договор (BKI_API_URL в .env).
const { db } = require('./db');
const fssp = require('./fssp');

const FSSP_MANUAL_URL = 'https://fssp.gov.ru/iss/ip';

function blacklistCheck(a) {
  const hits = db.prepare(`
    SELECT * FROM blacklist
    WHERE (passport_series = ? AND passport_number = ?)
       OR (phone IS NOT NULL AND phone <> '' AND phone = ?)
       OR (lower_ru(last_name) = lower_ru(?) AND lower_ru(first_name) = lower_ru(?)
           AND lower_ru(coalesce(middle_name,'')) = lower_ru(coalesce(?,'')) AND birth_date = ?)
  `).all(a.passport_series, a.passport_number, a.phone, a.last_name, a.first_name, a.middle_name, a.birth_date);
  if (!hits.length) return { status: 'ok', details: 'Совпадений не найдено' };
  return { status: 'hit', details: hits.map((h) => h.reason).join('; ') };
}

function historyCheck(a) {
  const overdue = db.prepare(`
    SELECT ap.number, count(p.id) AS cnt
    FROM applications ap JOIN payments p ON p.application_id = ap.id
    WHERE ap.id <> ? AND ap.passport_series = ? AND ap.passport_number = ?
      AND p.paid_at IS NULL AND p.due_date < date('now', '-5 days')
    GROUP BY ap.id
  `).all(a.id, a.passport_series, a.passport_number);
  if (!overdue.length) return { status: 'ok', details: 'Просрочек по прошлым рассрочкам нет' };
  return {
    status: 'hit',
    details: 'Просрочка по договорам: ' + overdue.map((o) => `${o.number} (${o.cnt} плат.)`).join(', '),
  };
}

// Универсальный адаптер к внешнему поставщику. Ожидаемый ответ: { "found": bool, "details": "..." }.
// Под конкретного поставщика достаточно поправить формат запроса/ответа здесь.
async function externalCheck(prefix, a) {
  const url = process.env[`${prefix}_API_URL`];
  if (!url) return { status: 'not_configured', details: 'Поставщик данных не подключён' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env[`${prefix}_API_TOKEN`] || ''}`,
      },
      body: JSON.stringify({
        last_name: a.last_name, first_name: a.first_name, middle_name: a.middle_name,
        birth_date: a.birth_date, passport_series: a.passport_series, passport_number: a.passport_number,
        reg_address: a.reg_address,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.found
      ? { status: 'hit', details: data.details || 'Найдены записи' }
      : { status: 'ok', details: data.details || 'Записей не найдено' };
  } catch (e) {
    return { status: 'error', details: `Ошибка запроса: ${e.message}` };
  }
}

async function runChecks(a) {
  const items = [
    { key: 'blacklist', title: 'Внутренний стоп-лист', ...blacklistCheck(a) },
    { key: 'history', title: 'История рассрочек в системе', ...historyCheck(a) },
    { key: 'fssp', title: 'ФССП — исполнительные производства', ...(await fssp.check(a)) },
    { key: 'bki', title: 'Банковские стоп-листы / кредитная история (БКИ)', ...(await externalCheck('BKI', a)) },
  ];
  const f = items.find((i) => i.key === 'fssp');
  delete f.raw;
  return { ...summary(items), checkedAt: new Date().toISOString() };
}

// Итог по пунктам: что-то найдено — отказ; ФССП не проверена — ждём решения администратора
function summary(items) {
  const f = items.find((i) => i.key === 'fssp');
  if (items.some((i) => i.status === 'hit')) return { status: 'hit', items };
  if (f.status !== 'ok') {
    f.status = 'pending';
    f.details = 'Ожидает проверки администратором';
    return { status: 'pending', items };
  }
  return { status: 'clean', items };
}

// Решение администратора по ФССП для заявки в ожидании
function decideFssp(result, { clean, comment }) {
  const f = result.items.find((i) => i.key === 'fssp');
  f.status = clean ? 'ok' : 'hit';
  f.details = (clean ? 'Проверено администратором — исполнительных производств нет' : 'Проверено администратором — найдены исполнительные производства')
    + (comment ? `. ${comment}` : '');
  f.manual = true;
  return { ...summary(result.items), checkedAt: result.checkedAt, decidedAt: new Date().toISOString() };
}

const fsspConfigured = () => fssp.configured();

module.exports = { runChecks, decideFssp, fsspConfigured, FSSP_MANUAL_URL };
