// Фоновые задачи: SMS-напоминания о платеже и формирование претензий.
// Запускаются при старте и каждые 30 минут; повторный запуск ничего не дублирует.
const { db, getSettings } = require('./db');
const payments = require('./payments');
const claims = require('./claims');
const sms = require('./sms');
const u = require('./util');

const REMIND_FROM = 9; // SMS отправляем с 9:00 до 21:00 по Москве
const REMIND_TO = 21;
const MAX_ATTEMPTS = 3;

function reminderText(row, ps) {
  const base = u.publicBase();
  const when = ps.daysLeft === 0 ? 'сегодня' : `до ${u.dateFmt(row.due_date)} (через ${ps.daysLeft} дн.)`;
  const link = base ? ` Оплата: ${base}/pay/${row.pay_token}` : ` Получатель: ${row.ip_name}, р/с ${row.account}`;
  return `Напоминаем: платёж ${u.moneyFmt(ps.remaining).replace(' ', ' ')} по рассрочке ${row.number} ${when}.${link}`;
}

async function sendReminders({ anyHour = false } = {}) {
  const hour = payments.hourNow();
  if (!anyHour && (hour < REMIND_FROM || hour >= REMIND_TO)) return 0;
  const { reminderDays } = getSettings();
  const t = payments.today();
  const rows = db.prepare(`
    SELECT p.*, a.number, a.phone, a.pay_token, e.name AS ip_name, e.account
    FROM payments p JOIN applications a ON a.id = p.application_id JOIN entrepreneurs e ON e.id = a.entrepreneur_id
    WHERE a.status = 'signed' AND p.paid_amount < p.amount AND p.reminded_at IS NULL
      AND p.due_date >= ? AND p.due_date <= date(?, ?)
  `).all(t, t, `+${reminderDays} days`);
  let sent = 0;
  for (const row of rows) {
    const ps = payments.paymentState(row, t);
    const ok = await sms.notify({ applicationId: row.application_id, paymentId: row.id, kind: 'reminder', phone: row.phone, text: reminderText(row, ps) });
    const errors = db.prepare("SELECT count(*) c FROM notifications WHERE payment_id = ? AND kind = 'reminder' AND status = 'error'").get(row.id).c;
    if (ok || errors >= MAX_ATTEMPTS) db.prepare("UPDATE payments SET reminded_at = datetime('now') WHERE id = ?").run(row.id);
    if (ok) sent++;
  }
  return sent;
}

let running = false;
// manual — запуск администратором из настроек: SMS уходят в любое время суток
async function runAll({ manual = false } = {}) {
  if (running) return null;
  running = true;
  try {
    const created = claims.createDue();
    const sent = await sendReminders({ anyHour: manual });
    if (created.length || sent) console.log(`[задачи] напоминаний: ${sent}, новых претензий: ${created.length}`);
    return { sent, claims: created.length };
  } catch (e) {
    console.error('[задачи] ошибка:', e);
    return null;
  } finally {
    running = false;
  }
}

function start() {
  setTimeout(runAll, 5000);
  setInterval(runAll, 30 * 60e3);
}

module.exports = { start, runAll, sendReminders, reminderText };
