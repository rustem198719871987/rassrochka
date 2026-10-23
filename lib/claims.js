// Претензии по просрочке. Создаются автоматически, когда платёж просрочен на N дней
// (Настройки → «Претензия через, дней»), и закрываются, когда долг погашен.
const { db, getSettings } = require('./db');

const CLAIM_STATUS = {
  new: 'Сформирована', handed: 'Передана руководителю', delivered: 'Вручена клиенту', closed: 'Закрыта',
};
const OPEN = "('new','handed','delivered')";

function openClaim(applicationId) {
  return db.prepare(`SELECT * FROM claims WHERE application_id = ? AND status IN ${OPEN} ORDER BY id DESC LIMIT 1`).get(applicationId);
}

// Создаёт претензии по всем договорам с просрочкой не меньше порога. Возвращает созданные.
function createDue() {
  const payments = require('./payments');
  const { claimAfterDays } = getSettings();
  const t = payments.today();
  const apps = db.prepare(`
    SELECT DISTINCT a.id, a.number FROM applications a JOIN payments p ON p.application_id = a.id
    WHERE a.status = 'signed' AND p.paid_amount < p.amount AND p.due_date <= date(?, ?)
  `).all(t, `-${claimAfterDays} days`);
  const created = [];
  for (const a of apps) {
    if (openClaim(a.id)) continue;
    const d = payments.debt(a.id, t);
    if (!d.rows.length || d.maxDays < claimAfterDays) continue;
    const seq = db.prepare('SELECT count(*) c FROM claims WHERE application_id = ?').get(a.id).c + 1;
    const info = db.prepare(`INSERT INTO claims (application_id, number, overdue_amount, overdue_days, details)
                             VALUES (?, ?, ?, ?, ?)`)
      .run(a.id, `П-${a.number}${seq > 1 ? '/' + seq : ''}`, d.overdue, d.maxDays,
        JSON.stringify({ asOf: t, rows: d.rows.map((p) => ({ n: p.n, due_date: p.due_date, amount: p.amount, remaining: p.remaining, days: p.overdueDays })) }));
    created.push(info.lastInsertRowid);
  }
  return created;
}

// Закрывает открытую претензию, если просроченной задолженности больше нет
function closeIfSettled(applicationId) {
  const c = openClaim(applicationId);
  if (!c) return;
  const payments = require('./payments');
  if (payments.debt(applicationId).rows.length) return;
  db.prepare("UPDATE claims SET status = 'closed', closed_at = datetime('now'), close_reason = 'Просроченная задолженность погашена' WHERE id = ?").run(c.id);
}

module.exports = { createDue, closeIfSettled, openClaim, CLAIM_STATUS };
