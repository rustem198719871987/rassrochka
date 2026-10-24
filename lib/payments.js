// Учёт оплат по рассрочке.
// Каждое поступление денег — запись в payment_records. График (payments) закрывается только
// подтверждёнными записями: банковскими из выписки и наличными после проверки администратора.
const { db } = require('./db');

const TZ = process.env.TZ_DISPLAY || 'Europe/Moscow';
const isoFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const today = () => isoFmt.format(new Date());
const hourNow = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date()));

// Разница в днях между датами YYYY-MM-DD (b − a)
const days = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3);

const METHOD = { bank: 'Банковский перевод', cash: 'Наличными в магазине', card: 'Картой в магазине', online: 'Онлайн (Сбербанк)', other: 'Другое' };
const RECORD_STATUS = { pending: 'Ждёт подтверждения', confirmed: 'Подтверждена', rejected: 'Отклонена', cancelled: 'Аннулирована' };

// Состояние одного платежа графика на дату
function paymentState(p, on = today()) {
  const remaining = p.amount - p.paid_amount;
  const left = days(on, p.due_date);
  let state = 'upcoming';
  if (remaining <= 0) state = 'paid';
  else if (left < 0) state = 'overdue';
  else if (left === 0) state = 'today';
  else if (left <= 5) state = 'soon';
  return { ...p, remaining: Math.max(0, remaining), daysLeft: left, overdueDays: left < 0 ? -left : 0, state, partial: remaining > 0 && p.paid_amount > 0 };
}

function daysLabel(ps) {
  if (ps.state === 'paid') return 'Оплачен';
  if (ps.state === 'today') return 'Сегодня';
  if (ps.state === 'overdue') return `Просрочка ${ps.overdueDays} дн.`;
  return `Через ${ps.daysLeft} дн.`;
}

// Пересчитывает график: подтверждённые поступления гасят платежи по порядку
function recalc(applicationId) {
  return db.transaction(() => {
    const pays = db.prepare('SELECT * FROM payments WHERE application_id = ? ORDER BY n').all(applicationId);
    const recs = db.prepare("SELECT * FROM payment_records WHERE application_id = ? AND status = 'confirmed' ORDER BY paid_on, id").all(applicationId);
    const state = pays.map((p) => ({ id: p.id, amount: p.amount, paid: 0, paidAt: null }));
    let extra = 0;
    for (const r of recs) {
      let money = r.amount;
      for (const p of state) {
        if (!money) break;
        const need = p.amount - p.paid;
        if (need <= 0) continue;
        const take = Math.min(need, money);
        p.paid += take;
        money -= take;
        if (p.paid >= p.amount) p.paidAt = r.paid_on;
      }
      extra += money;
    }
    const upd = db.prepare('UPDATE payments SET paid_amount = ?, paid_at = ? WHERE id = ?');
    for (const p of state) upd.run(p.paid, p.paidAt, p.id);

    const open = state.some((p) => p.paid < p.amount);
    db.prepare(`UPDATE applications SET status = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('signed','closed')`)
      .run(open ? 'signed' : 'closed', applicationId);
    require('./claims').closeIfSettled(applicationId);
    return { overpaid: extra };
  })();
}

function addRecord({ applicationId, amount, paidOn, method, status, comment, userId, bankTxId }) {
  const info = db.prepare(`INSERT INTO payment_records (application_id, amount, paid_on, method, status, bank_tx_id, comment, created_by,
      decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(applicationId, amount, paidOn, method, status, bankTxId || null, comment || null, userId || null,
      status === 'confirmed' ? userId || null : null, status === 'confirmed' ? new Date().toISOString() : null);
  if (status === 'confirmed') recalc(applicationId);
  return info.lastInsertRowid;
}

function decide(recordId, { approve, adminId, comment }) {
  const r = db.prepare("SELECT * FROM payment_records WHERE id = ? AND status = 'pending'").get(recordId);
  if (!r) return null;
  db.prepare(`UPDATE payment_records SET status = ?, decided_by = ?, decided_at = ?, decision_comment = ? WHERE id = ?`)
    .run(approve ? 'confirmed' : 'rejected', adminId, new Date().toISOString(), comment || null, recordId);
  if (approve) recalc(r.application_id);
  return r;
}

function cancel(recordId, { adminId, comment }) {
  const r = db.prepare("SELECT * FROM payment_records WHERE id = ? AND status = 'confirmed'").get(recordId);
  if (!r) return null;
  db.prepare(`UPDATE payment_records SET status = 'cancelled', decided_by = ?, decided_at = ?, decision_comment = ? WHERE id = ?`)
    .run(adminId, new Date().toISOString(), comment || 'Аннулировано администратором', recordId);
  if (r.bank_tx_id) db.prepare("UPDATE bank_transactions SET status = 'unmatched', application_id = NULL WHERE id = ?").run(r.bank_tx_id);
  recalc(r.application_id);
  return r;
}

// Просроченные платежи на дату
function debt(applicationId, on = today()) {
  const rows = db.prepare('SELECT * FROM payments WHERE application_id = ? ORDER BY n').all(applicationId)
    .map((p) => paymentState(p, on))
    .filter((p) => p.state === 'overdue');
  return {
    rows,
    overdue: rows.reduce((s, p) => s + p.remaining, 0),
    maxDays: rows.reduce((m, p) => Math.max(m, p.overdueDays), 0),
  };
}

// Список платежей графика для страницы «Платежи»
function upcoming({ sellerId, filter }) {
  const where = ["a.status = 'signed'", 'p.paid_amount < p.amount'];
  const params = [];
  if (sellerId) { where.push('a.seller_id = ?'); params.push(sellerId); }
  const t = today();
  if (filter === 'overdue') { where.push('p.due_date < ?'); params.push(t); }
  if (filter === 'week') { where.push('p.due_date >= ? AND p.due_date <= date(?, \'+7 days\')'); params.push(t, t); }
  if (filter === 'month') { where.push('p.due_date <= date(?, \'+30 days\')'); params.push(t); }
  return db.prepare(`
    SELECT p.*, a.number, a.last_name, a.first_name, a.middle_name, a.phone, a.id AS app_id, a.seller_id,
           e.name AS ip_name,
           (SELECT count(*) FROM payment_records r WHERE r.application_id = a.id AND r.status = 'pending') AS pending
    FROM payments p JOIN applications a ON a.id = p.application_id JOIN entrepreneurs e ON e.id = a.entrepreneur_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.due_date, a.id LIMIT 500`).all(...params).map((p) => paymentState(p, t));
}

module.exports = { today, hourNow, days, paymentState, daysLabel, recalc, addRecord, decide, cancel, debt, upcoming, METHOD, RECORD_STATUS };
