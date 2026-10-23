// Аннулирование оформленной рассрочки (отказ клиента, возврат товара).
// Продавец отправляет запрос с причиной, администратор одобряет или отклоняет.
const { db } = require('./db');
const commission = require('./commission');

const ANNUL_STATUS = { pending: 'На рассмотрении', approved: 'Одобрено', rejected: 'Отклонено' };

const pendingFor = (applicationId) =>
  db.prepare("SELECT * FROM annulments WHERE application_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(applicationId);

function request(a, reason, userId) {
  if (!['signed', 'closed'].includes(a.status)) return { error: 'Аннулировать можно только оформленную рассрочку' };
  if (pendingFor(a.id)) return { error: 'Запрос на аннулирование уже отправлен' };
  const id = db.prepare('INSERT INTO annulments (application_id, reason, requested_by) VALUES (?, ?, ?)').run(a.id, reason, userId).lastInsertRowid;
  return { id };
}

function approve(annulmentId, adminId, comment) {
  return db.transaction(() => {
    const r = db.prepare("SELECT * FROM annulments WHERE id = ? AND status = 'pending'").get(annulmentId);
    if (!r) return null;
    const a = db.prepare('SELECT * FROM applications WHERE id = ?').get(r.application_id);
    db.prepare("UPDATE annulments SET status = 'approved', decided_by = ?, decided_at = datetime('now'), decision_comment = ? WHERE id = ?")
      .run(adminId, comment || null, r.id);
    db.prepare("UPDATE applications SET status = 'annulled', annulled_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(a.id);
    // напоминания и претензии работают только по статусу 'signed' — по аннулированной они прекращаются
    db.prepare("UPDATE claims SET status = 'closed', closed_at = datetime('now'), close_reason = 'Рассрочка аннулирована' WHERE application_id = ? AND status <> 'closed'").run(a.id);
    commission.reverse(a);
    return r;
  })();
}

function reject(annulmentId, adminId, comment) {
  const r = db.prepare("UPDATE annulments SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), decision_comment = ? WHERE id = ? AND status = 'pending'")
    .run(adminId, comment, annulmentId);
  return r.changes > 0 ? db.prepare('SELECT * FROM annulments WHERE id = ?').get(annulmentId) : null;
}

module.exports = { request, approve, reject, pendingFor, ANNUL_STATUS };
