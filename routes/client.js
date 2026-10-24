// Личный кабинет клиента: вход по номеру договора и телефону с кодом из SMS.
// Клиент видит свои рассрочки (все договоры на этот телефон), график, сколько оплачено и осталось,
// договор и способы оплаты: QR-код с реквизитами и номером договора, СБП по ссылке банка.
const express = require('express');
const QRCode = require('qrcode');
const { db } = require('../lib/db');
const u = require('../lib/util');
const sms = require('../lib/sms');
const payments = require('../lib/payments');
const statement = require('../lib/statement');
const { paymentQr } = require('../lib/qr');

const router = express.Router();
const SESSION_MS = 30 * 60e3; // кабинет закрывается после 30 минут бездействия

// В рабочем режиме без SMS.ru вход закрыт: иначе код показывался бы на экране, и войти мог бы кто угодно
const loginAvailable = () => !sms.isDevMode() || process.env.NODE_ENV !== 'production';

const normNumber = (v) => {
  const s = String(v || '').trim();
  return statement.contractNumber(/^(РТ|RT|PT)/i.test(s) ? s : `РТ-${s}`);
};

// Договоры клиента: все оформленные на телефон, с которым он вошёл
const clientApps = (phone) => db.prepare(`SELECT * FROM applications WHERE phone = ? AND status IN ('signed','closed')
  ORDER BY contract_signed_at DESC`).all(phone);

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const c = req.session.client;
  req.client = c && c.until > Date.now() ? c : null;
  if (c && !req.client) delete req.session.client;
  if (req.client) req.session.client.until = Date.now() + SESSION_MS;
  next();
});

function renderLogin(res, extra = {}) {
  res.render('client/login', { title: 'Личный кабинет клиента', bodyClass: 'client-page', available: loginAvailable(), pending: null, error: null, form: {}, devCode: null, ...extra });
}

router.get('/', async (req, res) => {
  if (!req.client) return renderLogin(res, { pending: req.session.clientPending || null });
  const apps = clientApps(req.client.phone);
  if (!apps.length) { delete req.session.client; return res.redirect('/client'); }
  const a = apps.find((x) => x.id === Number(req.query.c)) || apps.find((x) => x.id === req.client.appId) || apps[0];
  const ip = db.prepare('SELECT * FROM entrepreneurs WHERE id = ?').get(a.entrepreneur_id);
  const t = payments.today();
  const schedule = db.prepare('SELECT * FROM payments WHERE application_id = ? ORDER BY n').all(a.id).map((p) => payments.paymentState(p, t));
  const next = schedule.find((p) => p.remaining > 0);
  const debt = payments.debt(a.id, t);
  const toPay = debt.overdue || (next ? next.remaining : 0);
  const qr = toPay ? await paymentQr(ip, { sum: toPay, purpose: `Оплата по договору рассрочки ${a.number}`, payer: a }) : null;
  const sbpQr = ip.sbp_url && toPay ? await QRCode.toDataURL(ip.sbp_url, { errorCorrectionLevel: 'M', margin: 1, width: 220 }) : null;
  const paid = schedule.reduce((s, p) => s + (p.paid_amount || 0), 0);
  res.render('client/cabinet', {
    title: `Рассрочка ${a.number}`, bodyClass: 'client-page', a, ip, apps, schedule, next, debt, toPay, qr, sbpQr, paid,
    left: schedule.reduce((s, p) => s + p.remaining, 0), daysLabel: payments.daysLabel,
  });
});

// Шаг 1: номер договора и телефон → код в SMS
router.post('/code', async (req, res) => {
  const form = { number: u.str(req.body.number, 30), phone: u.str(req.body.phone, 30) };
  if (!loginAvailable()) return renderLogin(res.status(503), { form });
  const number = normNumber(form.number);
  const phone = u.normPhone(form.phone);
  if (!number || !u.isPhone(phone)) return renderLogin(res.status(400), { form, error: 'Введите номер договора (например, РТ-26-000012) и телефон' });
  // SMS стоят денег, а перебор номеров не должен быть возможен: лимиты на адрес и на телефон
  if (!u.rateLimit(`client-code-ip:${req.ip}`, 10, 3600e3) || !u.rateLimit(`client-code-phone:${phone}`, 5, 3600e3)) {
    return renderLogin(res.status(429), { form, error: 'Слишком много попыток. Попробуйте через час.' });
  }
  const a = db.prepare("SELECT * FROM applications WHERE number = ? AND phone = ? AND status IN ('signed','closed')").get(number, phone);
  if (!a) return renderLogin(res.status(400), { form, error: 'Договор с таким номером и телефоном не найден. Проверьте данные или обратитесь в магазин.' });
  try {
    const devCode = await sms.sendCode({
      phone, purpose: 'client', applicationId: a.id,
      text: 'Код {code} для входа в личный кабинет Рассрочка.Топ. Никому не сообщайте код.',
    });
    req.session.clientPending = { appId: a.id, phone, number, masked: `+7 ••• •••-${phone.slice(7, 9)}-${phone.slice(9)}` };
    return renderLogin(res, { pending: req.session.clientPending, devCode });
  } catch (e) {
    return renderLogin(res.status(400), { form, error: e.message, pending: req.session.clientPending || null });
  }
});

// Шаг 2: код из SMS → вход
router.post('/login', (req, res, next) => {
  const p = req.session.clientPending;
  if (!p) return res.redirect('/client');
  if (!u.rateLimit(`client-login:${p.phone}`, 15, 3600e3)) return renderLogin(res.status(429), { pending: p, error: 'Слишком много попыток. Попробуйте через час.' });
  const r = sms.verifyCode({ phone: p.phone, purpose: 'client', applicationId: p.appId, code: req.body.code });
  if (!r.ok) return renderLogin(res.status(400), { pending: p, error: r.error });
  // новая сессия: вход сотрудника на этом устройстве завершается, клиент получает только свой кабинет
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.client = { phone: p.phone, appId: p.appId, until: Date.now() + SESSION_MS };
    res.redirect('/client');
  });
});

router.post('/reset', (req, res) => {
  delete req.session.clientPending;
  res.redirect('/client');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/client'));
});

// Договор для просмотра и печати — только свой
router.get('/contract/:id', async (req, res) => {
  if (!req.client) return res.redirect('/client');
  const a = clientApps(req.client.phone).find((x) => x.id === Number(req.params.id));
  if (!a) return res.status(404).render('error', { title: 'Не найдено', message: 'Договор не найден.' });
  const ip = db.prepare('SELECT * FROM entrepreneurs WHERE id = ?').get(a.entrepreneur_id);
  const schedule = db.prepare('SELECT * FROM payments WHERE application_id = ? ORDER BY n').all(a.id);
  const qr = await paymentQr(ip, { purpose: `Оплата по договору рассрочки ${a.number}`, payer: a });
  const seller = db.prepare('SELECT * FROM users WHERE id = ?').get(a.seller_id);
  res.render('docs/contract', { title: `Договор ${a.number}`, a, ip, schedule, qr, seller, backUrl: `/client?c=${a.id}`, backLabel: 'В личный кабинет' });
});

module.exports = router;
