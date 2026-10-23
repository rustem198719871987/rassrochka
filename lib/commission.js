// Вознаграждение продавца за оформленную рассрочку. Расчёт общий с браузером (public/js/calc.js).
const Calc = require('../public/js/calc');

const DEFAULT_RATES = { 1: 0, 2: 1, 3: 2.5 };

function commissionFor(a, { rates = DEFAULT_RATES, base = 'total' } = {}) {
  return Calc.commission({ months: a.months, price: a.product_price, total: a.total_amount, rates, base });
}


// ---------- журнал вознаграждения и выплаты ----------
// db подключается лениво: этот модуль используется и в миграции базы
const dbx = () => require('./db');

// Начисление при подписании договора
function accrue(a) {
  const { db, getSettings } = dbx();
  const s = getSettings();
  const c = commissionFor(a, { rates: s.commissionRates, base: s.commissionBase });
  db.prepare('UPDATE applications SET seller_commission_percent = ?, seller_commission = ? WHERE id = ?').run(c.percent, c.amount, a.id);
  if (c.amount) {
    db.prepare("INSERT INTO seller_ledger (seller_id, application_id, kind, amount, comment) VALUES (?, ?, 'commission', ?, ?)")
      .run(a.seller_id, a.id, c.amount, `Вознаграждение по договору ${a.number}`);
  }
  return c;
}

// Сторно при аннулировании: если вознаграждение уже выплачено, баланс уйдёт в минус и удержится из следующих
function reverse(a) {
  const { db } = dbx();
  const earned = db.prepare("SELECT coalesce(sum(amount), 0) s FROM seller_ledger WHERE application_id = ? AND kind IN ('commission','reversal')").get(a.id).s;
  if (earned > 0) {
    db.prepare("INSERT INTO seller_ledger (seller_id, application_id, kind, amount, comment) VALUES (?, ?, 'reversal', ?, ?)")
      .run(a.seller_id, a.id, -earned, `Аннулирование договора ${a.number}`);
  }
  return earned;
}

function balance(sellerId) {
  const { db } = dbx();
  const sum = (kind) => db.prepare('SELECT coalesce(sum(amount), 0) s FROM seller_ledger WHERE seller_id = ? AND kind = ?').get(sellerId, kind).s;
  const earned = sum('commission');
  const reversed = -sum('reversal');
  const paid = -sum('payout');
  const requested = db.prepare("SELECT coalesce(sum(amount), 0) s FROM payouts WHERE seller_id = ? AND status = 'requested'").get(sellerId).s;
  const total = earned - reversed - paid;
  return { earned, reversed, paid, requested, total, available: Math.max(0, total - requested) };
}

function requestPayout(sellerId, amount, details) {
  const { db } = dbx();
  return db.prepare('INSERT INTO payouts (seller_id, amount, details) VALUES (?, ?, ?)').run(sellerId, amount, details).lastInsertRowid;
}

function markPaid(payoutId, adminId, comment) {
  const { db } = dbx();
  return db.transaction(() => {
    const p = db.prepare("SELECT * FROM payouts WHERE id = ? AND status = 'requested'").get(payoutId);
    if (!p) return null;
    db.prepare("UPDATE payouts SET status = 'paid', decided_by = ?, decided_at = datetime('now'), decision_comment = ? WHERE id = ?").run(adminId, comment || null, p.id);
    db.prepare("INSERT INTO seller_ledger (seller_id, payout_id, kind, amount, comment) VALUES (?, ?, 'payout', ?, ?)")
      .run(p.seller_id, p.id, -p.amount, `Выплата № ${p.id}${comment ? ': ' + comment : ''}`);
    return p;
  })();
}

function rejectPayout(payoutId, adminId, comment) {
  const { db } = dbx();
  const r = db.prepare("UPDATE payouts SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), decision_comment = ? WHERE id = ? AND status = 'requested'")
    .run(adminId, comment, payoutId);
  return r.changes > 0;
}

const PAYOUT_STATUS = { requested: 'Ждёт выплаты', paid: 'Выплачено', rejected: 'Отклонено' };
const LEDGER_KIND = { commission: 'Начисление', reversal: 'Сторно', payout: 'Выплата' };

module.exports = { commissionFor, DEFAULT_RATES, accrue, reverse, balance, requestPayout, markPaid, rejectPayout, PAYOUT_STATUS, LEDGER_KIND };
