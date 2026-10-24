const crypto = require('crypto');
const session = require('express-session');
const { db } = require('./db');

// ---------- форматирование ----------
const moneyFmt = (k) => {
  if (k == null) return '';
  const rub = k / 100;
  return rub.toLocaleString('ru-RU', { minimumFractionDigits: k % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }) + ' ₽';
};

function dateFmt(v) {
  if (!v) return '';
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  return s;
}

function dateTimeFmt(v) {
  if (!v) return '';
  // SQLite datetime('now') — UTC без зоны
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(v) ? v : v.replace(' ', 'T') + 'Z');
  return d.toLocaleString('ru-RU', { timeZone: process.env.TZ_DISPLAY || 'Europe/Moscow' });
}

const phoneFmt = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length !== 11) return p || '';
  return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
};

const fio = (o) => [o.last_name, o.first_name, o.middle_name].filter(Boolean).join(' ');
const fioShort = (o) =>
  [o.last_name, o.first_name && o.first_name[0] + '.', o.middle_name && o.middle_name[0] + '.'].filter(Boolean).join(' ');

const USER_STATUS = {
  pending: 'На проверке', approved: 'Одобрен', rejected: 'Отклонён', correction: 'На корректировке', blocked: 'Заблокирован',
};
const APP_STATUS = {
  draft: 'Черновик', approved: 'Одобрена', declined: 'Отказ', signed: 'Оформлена', cancelled: 'Отменена', closed: 'Погашена', annulled: 'Аннулирована',
};

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------- нормализация и проверка ввода ----------
const normPhone = (v) => {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 10) d = '7' + d;
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  return d;
};
const isPhone = (d) => /^7\d{10}$/.test(d);
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const rubToKop = (v) => Math.round(Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')) * 100);

function isValidDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00');
  return !Number.isNaN(d.getTime()) && d.getFullYear() > 1900;
}

function ageOn(birth) {
  const b = new Date(birth + 'T00:00:00');
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age--;
  return age;
}

// Общие поля «человек + паспорт + прописка» (продавец и клиент)
function readPerson(body, errors) {
  const p = {
    last_name: str(body.last_name, 80),
    first_name: str(body.first_name, 80),
    middle_name: str(body.middle_name, 80),
    birth_date: str(body.birth_date, 10),
    passport_series: str(body.passport_series).replace(/\D/g, ''),
    passport_number: str(body.passport_number).replace(/\D/g, ''),
    passport_issued_by: str(body.passport_issued_by, 300),
    passport_issue_date: str(body.passport_issue_date, 10),
    passport_dept_code: str(body.passport_dept_code).replace(/[^\d]/g, '').replace(/^(\d{3})(\d{3})$/, '$1-$2'),
    reg_address: str(body.reg_address, 500),
  };
  if (!p.last_name) errors.last_name = 'Укажите фамилию';
  if (!p.first_name) errors.first_name = 'Укажите имя';
  if (!isValidDate(p.birth_date)) errors.birth_date = 'Укажите дату рождения';
  else if (ageOn(p.birth_date) < 18) errors.birth_date = 'Должно быть не меньше 18 лет';
  if (!/^\d{4}$/.test(p.passport_series)) errors.passport_series = '4 цифры';
  if (!/^\d{6}$/.test(p.passport_number)) errors.passport_number = '6 цифр';
  if (!p.passport_issued_by) errors.passport_issued_by = 'Укажите, кем выдан паспорт';
  if (!isValidDate(p.passport_issue_date)) errors.passport_issue_date = 'Укажите дату выдачи';
  if (!/^\d{3}-\d{3}$/.test(p.passport_dept_code)) errors.passport_dept_code = 'Формат 000-000';
  if (!p.reg_address) errors.reg_address = 'Укажите адрес регистрации';
  return p;
}

// ---------- сессии в SQLite ----------
class SqliteStore extends session.Store {
  constructor() {
    super();
    this.getStmt = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?');
    this.setStmt = db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires');
    this.delStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 3600e3).unref();
  }
  expiry(sess) {
    return sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400e3;
  }
  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try { this.setStmt.run(sid, JSON.stringify(sess), this.expiry(sess)); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { this.delStmt.run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

// ---------- доступ, CSRF, flash ----------
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (req.method === 'POST') {
    // формы с файлами (multipart) разбираются позже, поэтому их токен передаётся в адресе формы
    const multipart = /^multipart\/form-data/i.test(req.get('content-type') || '');
    const token = multipart ? req.query._csrf : req.body && req.body._csrf;
    const given = Buffer.from(typeof token === 'string' ? token : '');
    const expected = Buffer.from(req.session.csrf);
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) {
      return res.status(403).render('error', { title: 'Ошибка', message: 'Сессия устарела. Обновите страницу и повторите действие.' });
    }
  }
  next();
}

function flash(req, type, msg) {
  req.session.flash = { type, msg };
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: 'Нет доступа', message: 'Раздел доступен только администратору.' });
  next();
}

function requireSeller(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role === 'admin') return next();
  if (req.user.status !== 'approved') return res.redirect('/status');
  next();
}

// Простая защита от перебора паролей, SMS-кодов и частых запросов
const hits = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length <= limit;
}
// старые отметки удаляем, чтобы поток запросов с разных адресов не занимал память
setInterval(() => {
  const now = Date.now();
  for (const [key, list] of hits) if (!list.length || now - list[list.length - 1] > 24 * 3600e3) hits.delete(key);
}, 10 * 60e3).unref();

// Middleware: не больше limit запросов за windowMs с одного адреса для маршрута
function limitByIp(name, limit, windowMs, { json = false, message = 'Слишком много запросов. Подождите немного и повторите.' } = {}) {
  return (req, res, next) => {
    if (rateLimit(`${name}:${req.ip}`, limit, windowMs)) return next();
    res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
    if (json) return res.status(429).json({ error: message });
    return res.status(429).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Подождите</title><p style="font:16px sans-serif;padding:40px">${message}</p>`);
  };
}

// Завершает все сессии пользователя, кроме текущей: после смены пароля, телефона или блокировки
function endSessions(userId, keepSid = null) {
  db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ? AND sid IS NOT ?").run(userId, keepSid);
}

// Адрес сайта для ссылок в QR-кодах и SMS: .env → настройки → адрес текущего запроса
function publicBase(req) {
  const saved = db.prepare("SELECT value FROM settings WHERE key = 'public_url'").get();
  const base = process.env.PUBLIC_URL || (saved && saved.value) || (req ? `${req.protocol}://${req.get('host')}` : '');
  return base.replace(/\/$/, '');
}

module.exports = {
  publicBase,
  moneyFmt, dateFmt, dateTimeFmt, phoneFmt, fio, fioShort, USER_STATUS, APP_STATUS, todayIso, isoDate,
  normPhone, isPhone, str, rubToKop, isValidDate, ageOn, readPerson,
  SqliteStore, csrf, flash, requireAdmin, requireSeller, rateLimit, limitByIp, endSessions,
};
