// Проверка клиента по базам перед выдачей рассрочки.
//
// 1. Внутренний стоп-лист — ведёт администратор (работает сразу).
// 2. Внутренняя история — просрочки клиента по прошлым рассрочкам в этой системе.
// 3. ФССП (исполнительные производства) — через внешнего поставщика данных.
// 4. Банковские стоп-листы / кредитная история (БКИ) — через внешнего поставщика.
//
// Открытого бесплатного API ФССП/БКИ для массовых проверок нет, поэтому пункты 3–4 —
// адаптер к поставщику, с которым заключён договор. Пока адрес не задан в .env,
// проверка помечается «не подключена», и ФССП проверяется вручную на fssp.gov.ru.
const { db } = require('./db');

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

async function runChecks(a, { fsspManualConfirmed }) {
  const items = [
    { key: 'blacklist', title: 'Внутренний стоп-лист', ...blacklistCheck(a) },
    { key: 'history', title: 'История рассрочек в системе', ...historyCheck(a) },
    { key: 'fssp', title: 'ФССП — исполнительные производства', ...(await externalCheck('FSSP', a)) },
    { key: 'bki', title: 'Банковские стоп-листы / кредитная история (БКИ)', ...(await externalCheck('BKI', a)) },
  ];

  const fssp = items.find((i) => i.key === 'fssp');
  if (fssp.status !== 'ok' && fssp.status !== 'hit' && fsspManualConfirmed) {
    fssp.status = 'ok';
    fssp.details = 'Проверено продавцом вручную на сайте ФССП — задолженностей не найдено';
    fssp.manual = true;
  }

  const hit = items.some((i) => i.status === 'hit');
  return { status: hit ? 'hit' : 'clean', items, checkedAt: new Date().toISOString() };
}

const fsspConfigured = () => Boolean(process.env.FSSP_API_URL);

module.exports = { runChecks, fsspConfigured, FSSP_MANUAL_URL };
