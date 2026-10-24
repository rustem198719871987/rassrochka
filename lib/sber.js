// Онлайн-оплата через интернет-эквайринг Сбербанка: клиент платит на платёжной странице Сбера
// (СБП или картой — что включено в договоре эквайринга), и платёж сразу попадает в график.
//
// У каждого ИП свой договор эквайринга: логин и пароль API магазина вводятся в карточке ИП (пароль хранится
// зашифрованным). Адрес API по умолчанию — рабочий шлюз Сбера; для теста укажите адрес тестового стенда из письма Сбера.
//
// Сайт не доверяет ни возврату клиента со страницы банка, ни уведомлению банка: в обоих случаях он сам
// спрашивает у Сбера статус заказа (getOrderStatusExtended.do) и зачитывает оплату только при статусе «оплачен».
// Повторный зачёт исключён: заказ переводится в «оплачен» одной проверкой в базе.
const { db } = require('./db');
const storage = require('./storage');
const payments = require('./payments');

const DEFAULT_URL = 'https://securepayments.sberbank.ru/payment/rest/';
const ORDER_TTL_SEC = 20 * 60; // столько действует платёжная страница
const STATUS = { created: 'Ожидает оплаты', paid: 'Оплачено', failed: 'Не оплачено', expired: 'Время вышло' };

const configured = (ip) => Boolean(ip && ip.sber_login && ip.sber_password);

async function call(ip, method, params) {
  const base = (ip.sber_api_url || DEFAULT_URL).replace(/\/?$/, '/');
  const body = new URLSearchParams({ userName: ip.sber_login, password: storage.decryptText(ip.sber_password), ...params });
  let res;
  try {
    res = await fetch(base + method, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error('Сбербанк не отвечает — попробуйте через минуту');
  }
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`Сбербанк: неожиданный ответ (HTTP ${res.status})`);
  if (data.errorCode && String(data.errorCode) !== '0') throw new Error(`Сбербанк: ${data.errorMessage || `ошибка ${data.errorCode}`}`);
  return data;
}

// Создаёт заказ в Сбере и возвращает адрес платёжной страницы
async function createPayment({ app, ip, amount, siteUrl }) {
  if (!configured(ip)) throw new Error('Онлайн-оплата для этого договора не подключена');
  const id = db.prepare('INSERT INTO online_payments (application_id, entrepreneur_id, amount) VALUES (?, ?, ?)').run(app.id, ip.id, amount).lastInsertRowid;
  // номер заказа в Сбере — латиницей и цифрами: RT26000012-15
  const orderNumber = `RT${app.number.replace(/\D/g, '')}-${id}`;
  db.prepare('UPDATE online_payments SET order_number = ? WHERE id = ?').run(orderNumber, id);
  try {
    const back = `${siteUrl}/client/pay/${id}/return`;
    const data = await call(ip, 'register.do', {
      orderNumber, amount: String(amount), currency: '643', language: 'ru',
      returnUrl: back, failUrl: back, sessionTimeoutSecs: String(ORDER_TTL_SEC),
      description: `Оплата по договору рассрочки ${app.number}`,
    });
    // платёжная страница — только https (http допускается лишь для тестового шлюза на этом же компьютере)
    const local = process.env.NODE_ENV !== 'production' && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(data.formUrl || '');
    if (!data.orderId || !(/^https:\/\//.test(data.formUrl || '') || local)) throw new Error('Сбербанк не вернул платёжную страницу');
    db.prepare('UPDATE online_payments SET bank_order_id = ? WHERE id = ?').run(String(data.orderId), id);
    return { id, formUrl: data.formUrl };
  } catch (e) {
    db.prepare("UPDATE online_payments SET status = 'failed', error = ? WHERE id = ?").run(e.message.slice(0, 300), id);
    throw e;
  }
}

// Зачёт оплаты в график — ровно один раз
function markPaid(op, amount) {
  return db.transaction(() => {
    const changed = db.prepare("UPDATE online_payments SET status = 'paid', paid_amount = ?, paid_at = datetime('now') WHERE id = ? AND status = 'created'")
      .run(amount, op.id).changes;
    if (!changed) return false;
    const rid = payments.addRecord({
      applicationId: op.application_id, amount, paidOn: payments.today(), method: 'online', status: 'confirmed',
      comment: `Онлайн-оплата через Сбербанк, заказ ${op.order_number}`, userId: null,
    });
    db.prepare('UPDATE online_payments SET payment_record_id = ? WHERE id = ?').run(rid, op.id);
    return true;
  })();
}

// Спрашивает у Сбера статус заказа и при оплате зачитывает её. Возвращает актуальную запись.
async function refresh(opId) {
  const op = db.prepare('SELECT * FROM online_payments WHERE id = ?').get(opId);
  if (!op || op.status !== 'created' || !op.bank_order_id) return op;
  const ip = db.prepare('SELECT * FROM entrepreneurs WHERE id = ?').get(op.entrepreneur_id);
  const data = await call(ip, 'getOrderStatusExtended.do', { orderId: op.bank_order_id });
  const st = Number(data.orderStatus);
  // 2 — оплачен; 3 — отменён; 4 — возвращён; 6 — отклонён
  if (st === 2) {
    const amount = Number(data.amount) > 0 ? Number(data.amount) : op.amount;
    markPaid(op, amount);
  } else if ([3, 4, 6].includes(st)) {
    db.prepare("UPDATE online_payments SET status = 'failed', error = ? WHERE id = ? AND status = 'created'")
      .run(String(data.actionCodeDescription || `статус ${st}`).slice(0, 300), op.id);
  } else if (Date.now() - Date.parse(op.created_at.replace(' ', 'T') + 'Z') > 24 * 3600e3) {
    db.prepare("UPDATE online_payments SET status = 'expired' WHERE id = ? AND status = 'created'").run(op.id);
  }
  return db.prepare('SELECT * FROM online_payments WHERE id = ?').get(op.id);
}

// Фоновая перепроверка: клиент мог закрыть страницу банка, а уведомление — не дойти
async function refreshPending() {
  const rows = db.prepare("SELECT id FROM online_payments WHERE status = 'created' AND bank_order_id IS NOT NULL AND created_at > datetime('now', '-2 days')").all();
  for (const r of rows) await refresh(r.id).catch((e) => console.error('[сбер] статус не получен:', e.message));
  db.prepare("UPDATE online_payments SET status = 'expired' WHERE status = 'created' AND created_at <= datetime('now', '-2 days')").run();
  return rows.length;
}

function start() {
  setInterval(() => refreshPending().catch((e) => console.error('[сбер]', e)), 10 * 60e3).unref();
}

module.exports = { configured, createPayment, refresh, refreshPending, start, STATUS, DEFAULT_URL };
