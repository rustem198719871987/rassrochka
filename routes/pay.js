// Страница оплаты для клиента: ссылка приходит в SMS. Вход не нужен, доступ — по секретной ссылке.
// Показывает только то, что нужно для оплаты: график, сколько дней осталось, QR и реквизиты.
const express = require('express');
const { db, getSettings } = require('../lib/db');
const payments = require('../lib/payments');
const { paymentQr } = require('../lib/qr');
const u = require('../lib/util');

const router = express.Router();

// Уведомление Сбербанка об операции по заказу. Параметрам не доверяем: по mdOrder сами спрашиваем статус у банка.
router.get('/sber/callback', async (req, res) => {
  const op = db.prepare('SELECT id FROM online_payments WHERE bank_order_id = ?').get(String(req.query.mdOrder || ''));
  if (op) await require('../lib/sber').refresh(op.id).catch((e) => console.error('[сбер] уведомление:', e.message));
  res.type('text/plain').send('OK');
});

router.get('/:token', async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  const token = String(req.params.token || '');
  const a = /^[a-f0-9]{36}$/.test(token)
    ? db.prepare("SELECT * FROM applications WHERE pay_token = ? AND status IN ('signed','closed')").get(token)
    : null;
  if (!a) return res.status(404).render('error', { title: 'Ссылка недействительна', message: 'Проверьте ссылку из SMS или обратитесь в магазин.', settings: getSettings(), flash: null });
  const ip = db.prepare('SELECT * FROM entrepreneurs WHERE id = ?').get(a.entrepreneur_id);
  const t = payments.today();
  const schedule = db.prepare('SELECT * FROM payments WHERE application_id = ? ORDER BY n').all(a.id).map((p) => payments.paymentState(p, t));
  const next = schedule.find((p) => p.remaining > 0);
  const debt = payments.debt(a.id, t);
  const toPay = debt.overdue || (next ? next.remaining : 0);
  const qr = toPay ? await paymentQr(ip, { sum: toPay, purpose: `Оплата по договору рассрочки ${a.number}`, payer: a }) : null;
  res.render('pay/page', {
    title: `Рассрочка ${a.number}`, bodyClass: 'client-page', a, ip, schedule, next, debt, toPay, qr,
    left: schedule.reduce((s, p) => s + p.remaining, 0),
    settings: getSettings(), money: u.moneyFmt, date: u.dateFmt, phone: u.phoneFmt, fioShort: u.fioShort, daysLabel: payments.daysLabel, flash: null,
  });
});

module.exports = router;
