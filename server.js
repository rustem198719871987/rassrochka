const path = require('path');
const express = require('express');
require('./lib/express-async');
const session = require('express-session');

const { db, getSettings, getSessionSecret, ensureAdmin } = require('./lib/db');
const u = require('./lib/util');
const sms = require('./lib/sms');
const payments = require('./lib/payments');
const jobs = require('./lib/jobs');
const fms = require('./lib/fms');

ensureAdmin();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Заголовки безопасности. CSP разрешает скрипты, шрифты и запросы только с этого сайта —
// внедрённый чужой скрипт не выполнится и не сможет никуда отправить данные.
// Сайт закрыт от поисковых систем: запрет индексации на всех ответах, включая файлы и страницы оплаты.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Второй рубеж от потока запросов (первый — nginx): не больше 300 запросов в минуту с одного адреса
app.use(u.limitByIp('all', 300, 60e3));

// Версия стилей и скриптов: меняется при обновлении сайта, чтобы браузер не показывал старые файлы
const assetVersion = require('crypto').createHash('sha1')
  .update(['css/style.css', 'js/app.js', 'js/calc.js'].map((f) => require('fs').readFileSync(path.join(__dirname, 'public', f))).join(''))
  .digest('hex').slice(0, 10);
app.use((req, res, next) => { res.locals.v = assetVersion; next(); });
app.use(express.urlencoded({ extended: true, limit: '200kb' }));


// «Кем выдан» по коду подразделения — подсказка в анкетах из открытого справочника
app.get('/api/fms', u.limitByIp('fms', 60, 60e3, { json: true }), (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : undefined;
  const r = fms.issuedBy(req.query.code, { issueDate: date });
  res.json(r ? { value: r.value, options: r.options } : { value: null, options: [] });
});

// Страница загрузки фото с телефона: вход по одноразовой ссылке, без сессии и CSRF
app.post('/m/:token', u.limitByIp('m-post', 20, 10 * 60e3, { json: true }));
app.use('/m', require('./routes/mobile'));
// Страница оплаты для клиента по ссылке из SMS
app.use('/pay', u.limitByIp('pay', 60, 60e3), require('./routes/pay'));

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
  // страницы кабинета с персональными данными не сохраняются в кэше браузера (общий компьютер в магазине)
  if (req.user) res.set('Cache-Control', 'no-store');
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
    res.locals.badgeChecks = db.prepare("SELECT count(*) AS c FROM applications WHERE check_status = 'pending'").get().c;
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
  if (res.headersSent) return next(err);
  res.status(500).render('error', { title: 'Ошибка', message: 'Что-то пошло не так. Попробуйте ещё раз.' });
});

// фоновые ошибки (SMS, распознавание после ответа) записываем в журнал, сайт продолжает работать
process.on('unhandledRejection', (e) => console.error('Необработанная ошибка:', e));

// На сервере сайт слушает только 127.0.0.1 (HOST в /etc/rassrochka.env): снаружи он доступен лишь через nginx с его лимитами
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  console.log(`Рассрочка.Топ запущена: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (process.env.JOBS !== 'off') jobs.start();
});
// медленные соединения не держат сервер: заголовки — до 20 с, весь запрос (с фото) — до 2 минут
server.headersTimeout = 20e3;
server.requestTimeout = 120e3;
server.keepAliveTimeout = 30e3;
