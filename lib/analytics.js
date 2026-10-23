// Аналитика для администратора. Аннулированные рассрочки не учитываются нигде.
// Прибыль = наценка за рассрочку − вознаграждение продавцов (себестоимость товара система не знает).
const { db } = require('./db');
const payments = require('./payments');

// Даты договоров хранятся в UTC; день считаем по Москве (UTC+3, без перехода на летнее время)
const SIGNED_DAY = "date(a.contract_signed_at, '+3 hours')";
const COUNTED = "a.status IN ('signed','closed')";

const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(s + 'T00:00:00Z');
const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

const PRESETS = { month: 'Этот месяц', prev: 'Прошлый месяц', quarter: 'Этот квартал', year: 'Этот год', all: 'Всё время' };

function period(query) {
  const today = payments.today();
  const [y, m] = today.split('-').map(Number);
  const valid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(parse(s).getTime());
  if (valid(query.from) && valid(query.to) && query.from <= query.to) {
    return { from: query.from, to: query.to, preset: 'custom', label: 'Свой период' };
  }
  const preset = PRESETS[query.p] ? query.p : 'month';
  let from = today;
  let to = today;
  if (preset === 'month') from = iso(new Date(Date.UTC(y, m - 1, 1)));
  if (preset === 'prev') { from = iso(new Date(Date.UTC(y, m - 2, 1))); to = iso(new Date(Date.UTC(y, m - 1, 0))); }
  if (preset === 'quarter') from = iso(new Date(Date.UTC(y, Math.floor((m - 1) / 3) * 3, 1)));
  if (preset === 'year') from = iso(new Date(Date.UTC(y, 0, 1)));
  if (preset === 'all') {
    const first = db.prepare(`SELECT min(${SIGNED_DAY}) d FROM applications a WHERE ${COUNTED}`).get().d;
    from = first || today;
  }
  return { from, to, preset, label: PRESETS[preset] };
}

// Сдвиг даты на n месяцев; 31 марта − 1 мес = 28/29 февраля
function shiftMonths(s, n) {
  const d = parse(s);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d.getUTCDate(), last));
  return iso(t);
}

// Период для сравнения: тот же отрезок прошлого месяца / квартала / года,
// для «всего времени» и своего периода — такой же по длине отрезок перед выбранным
function previous({ from, to, preset }) {
  if (preset === 'prev') {
    const start = shiftMonths(from, -1);
    const d = parse(start);
    return { from: start, to: iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))) };
  }
  const shift = { month: 1, quarter: 3, year: 12 }[preset];
  if (shift) return { from: shiftMonths(from, -shift), to: shiftMonths(to, -shift) };
  const len = Math.round((parse(to) - parse(from)) / 86400e3) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

function summary({ from, to }) {
  const s = db.prepare(`
    SELECT count(*) AS count, coalesce(sum(a.total_amount), 0) AS total, coalesce(sum(a.product_price), 0) AS price,
           coalesce(sum(a.markup_amount), 0) AS markup, coalesce(sum(a.seller_commission), 0) AS commission,
           coalesce(sum(a.down_payment), 0) AS down, avg(a.months) AS avg_months
    FROM applications a WHERE ${COUNTED} AND ${SIGNED_DAY} BETWEEN ? AND ?`).get(from, to);
  const received = db.prepare(`
    SELECT coalesce(sum(r.amount), 0) s FROM payment_records r JOIN applications a ON a.id = r.application_id
    WHERE r.status = 'confirmed' AND a.status <> 'annulled' AND r.paid_on BETWEEN ? AND ?`).get(from, to).s;
  const annulled = db.prepare(`SELECT count(*) c FROM applications a WHERE a.status = 'annulled' AND ${SIGNED_DAY} BETWEEN ? AND ?`).get(from, to).c;
  return {
    ...s,
    profit: s.markup - s.commission,
    avgCheck: s.count ? Math.round(s.total / s.count) : 0,
    received: received + s.down,
    annulled,
  };
}

// Текущее состояние портфеля (не зависит от периода)
function portfolio() {
  const t = payments.today();
  return db.prepare(`
    SELECT count(DISTINCT a.id) AS active,
           coalesce(sum(p.amount - p.paid_amount), 0) AS outstanding,
           coalesce(sum(CASE WHEN p.due_date < ? THEN p.amount - p.paid_amount ELSE 0 END), 0) AS overdue
    FROM applications a JOIN payments p ON p.application_id = a.id
    WHERE a.status = 'signed' AND p.paid_amount < p.amount`).get(t);
}

// Ряд по дням (до 62 дней) или по месяцам, с пустыми интервалами
function series({ from, to }) {
  const days = Math.round((parse(to) - parse(from)) / 86400e3) + 1;
  const byMonth = days > 62;
  const key = byMonth ? `substr(${SIGNED_DAY}, 1, 7)` : SIGNED_DAY;
  const rows = db.prepare(`
    SELECT ${key} AS k, count(*) AS count, coalesce(sum(a.markup_amount - a.seller_commission), 0) AS profit, coalesce(sum(a.total_amount), 0) AS total
    FROM applications a WHERE ${COUNTED} AND ${SIGNED_DAY} BETWEEN ? AND ? GROUP BY k`).all(from, to);
  const map = new Map(rows.map((r) => [r.k, r]));
  const out = [];
  if (byMonth) {
    let d = parse(from.slice(0, 7) + '-01');
    while (iso(d) <= to) {
      const k = iso(d).slice(0, 7);
      const r = map.get(k) || {};
      out.push({ key: k, short: MONTHS[d.getUTCMonth()], long: `${MONTHS_FULL[d.getUTCMonth()]} ${d.getUTCFullYear()}`, count: r.count || 0, profit: r.profit || 0, total: r.total || 0 });
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    }
  } else {
    for (let k = from; k <= to; k = addDays(k, 1)) {
      const r = map.get(k) || {};
      const d = parse(k);
      out.push({ key: k, short: String(d.getUTCDate()), long: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`, count: r.count || 0, profit: r.profit || 0, total: r.total || 0 });
    }
  }
  return { byMonth, points: out };
}

function breakdown({ from, to }, groupSql, joinSql = '') {
  return db.prepare(`
    SELECT ${groupSql} AS grp, count(*) AS count, coalesce(sum(a.total_amount), 0) AS total, coalesce(sum(a.markup_amount), 0) AS markup,
           coalesce(sum(a.seller_commission), 0) AS commission, coalesce(sum(a.markup_amount - a.seller_commission), 0) AS profit
    FROM applications a ${joinSql}
    WHERE ${COUNTED} AND ${SIGNED_DAY} BETWEEN ? AND ? GROUP BY grp ORDER BY profit DESC`).all(from, to);
}

const bySeller = (p) => breakdown(p, "trim(u.last_name || ' ' || substr(u.first_name, 1, 1) || '. ' || coalesce(substr(u.middle_name, 1, 1) || '.', ''))", 'JOIN users u ON u.id = a.seller_id');
const byIp = (p) => breakdown(p, 'e.name', 'JOIN entrepreneurs e ON e.id = a.entrepreneur_id');
const byTerm = (p) => breakdown(p, 'a.months').sort((x, y) => x.grp - y.grp);

// Деления оси: 0 и 3–5 «круглых» значений
function ticks(max) {
  if (max <= 0) return { top: 1, list: [0] };
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  const top = Math.ceil(max / step) * step;
  const list = [];
  for (let v = 0; v <= top + 1e-9; v += step) list.push(v);
  return { top, list };
}

const change = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

module.exports = { period, previous, summary, portfolio, series, bySeller, byIp, byTerm, ticks, change, PRESETS };
