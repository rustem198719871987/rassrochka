const path = require('path');
const express = require('express');
const session = require('express-session');

const { db, getSettings, getSessionSecret, ensureAdmin } = require('./lib/db');
const u = require('./lib/util');
const sms = require('./lib/sms');
const payments = require('./lib/payments');
const jobs = require('./lib/jobs');

ensureAdmin();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));

app.use((req, res, next) => {
  res.set({
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  next();
});

// Страница загрузки фото с телефона: вход по одноразовой ссылке, без сессии и CSRF
app.use('/m', require('./routes/mobile'));
// Страница оплаты для клиента по ссылке из SMS
app.use('/pay', require('./routes/pay'));

app.use(session({
  store: new u.SqliteStore(),
  secret: getSessionSecret(),
  name: 'rt.sid',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === '1',
    maxAge: 12 * 3600e3,
  },
}));

app.use((req, res, next) => {
  req.user = req.session.userId ? db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) : null;
  if (req.user && req.user.status === 'blocked') {
    req.session.userId = null;
    req.user = null;
  }
  res.locals.user = req.user;
  res.locals.path = req.path;
  res.locals.flash = req.session.flash;
  delete req.session.flash;
  res.locals.settings = getSettings();
  res.locals.smsDev = sms.isDevMode();
  Object.assign(res.locals, {
    money: u.moneyFmt, date: u.dateFmt, dateTime: u.dateTimeFmt, phone: u.phoneFmt,
    fio: u.fio, fioShort: u.fioShort, USER_STATUS: u.USER_STATUS, APP_STATUS: u.APP_STATUS,
    errors: {}, form: {},
  });
  if (req.user && req.user.role === 'admin') {
    res.locals.pendingSellers = db.prepare("SELECT count(*) AS c FROM users WHERE role='seller' AND status='pending'").get().c;
    res.locals.badgePayments = db.prepare("SELECT count(*) AS c FROM payment_records WHERE status = 'pending'").get().c;
    res.locals.badgeClaims = db.prepare("SELECT count(*) AS c FROM claims WHERE status = 'new'").get().c;
    res.locals.badgeAnnul = db.prepare("SELECT count(*) AS c FROM annulments WHERE status = 'pending'").get().c;
    res.locals.badgePayouts = db.prepare("SELECT count(*) AS c FROM payouts WHERE status = 'requested'").get().c;
  } else if (req.user && req.user.status === 'approved') {
    res.locals.badgePayments = db.prepare(`SELECT count(*) AS c FROM payments p JOIN applications a ON a.id = p.application_id
      WHERE a.seller_id = ? AND a.status = 'signed' AND p.paid_amount < p.amount AND p.due_date < ?`).get(req.user.id, payments.today()).c;
    res.locals.badgeClaims = db.prepare(`SELECT count(*) AS c FROM claims c JOIN applications a ON a.id = c.application_id
      WHERE a.seller_id = ? AND c.status = 'new'`).get(req.user.id).c;
  }
  next();
});

app.use(u.csrf);

app.use(require('./routes/auth'));
app.use('/app', require('./routes/seller'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).render('error', { title: 'Не найдено', message: 'Страница не найдена.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Ошибка', message: 'Что-то пошло не так. Попробуйте ещё раз.' });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Рассрочка.Топ запущена: http://localhost:${PORT}`);
  if (process.env.JOBS !== 'off') jobs.start();
});
