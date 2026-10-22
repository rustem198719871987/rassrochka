const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, setSetting, getSecret, secretFromEnv } = require('../lib/db');
const sms = require('../lib/sms');
const ocr = require('../lib/ocr');
const u = require('../lib/util');
const { setUserIps, PERSON_COLS } = require('./auth');

const router = express.Router();
router.use(u.requireAdmin);

const allIps = () => db.prepare('SELECT * FROM entrepreneurs ORDER BY active DESC, name').all();
const userIpIds = (id) => db.prepare('SELECT entrepreneur_id FROM user_entrepreneurs WHERE user_id = ?').all(id).map((r) => r.entrepreneur_id);

// ---------- главная ----------
router.get('/', (req, res) => {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const stats = {
    pending: one("SELECT count(*) c FROM users WHERE role='seller' AND status='pending'").c,
    sellers: one("SELECT count(*) c FROM users WHERE role='seller' AND status='approved'").c,
    ips: one('SELECT count(*) c FROM entrepreneurs WHERE active = 1').c,
    signed: one("SELECT count(*) c, coalesce(sum(total_amount),0) s FROM applications WHERE status IN ('signed','closed')"),
    month: one("SELECT count(*) c, coalesce(sum(total_amount),0) s FROM applications WHERE status IN ('signed','closed') AND contract_signed_at >= date('now','start of month')"),
    overdue: one("SELECT count(*) c, coalesce(sum(amount),0) s FROM payments WHERE paid_at IS NULL AND due_date < date('now')"),
    declined: one("SELECT count(*) c FROM applications WHERE status = 'declined'").c,
  };
  const pendingSellersList = db.prepare("SELECT * FROM users WHERE role='seller' AND status='pending' ORDER BY id DESC LIMIT 10").all();
  const recent = db.prepare(`SELECT a.*, e.name ip_name FROM applications a JOIN entrepreneurs e ON e.id = a.entrepreneur_id
                             WHERE a.status <> 'draft' ORDER BY a.updated_at DESC LIMIT 10`).all();
  res.render('admin/dashboard', { title: 'Панель администратора', stats, pendingSellersList, recent });
});

// ---------- продавцы ----------
router.get('/sellers', (req, res) => {
  const status = u.USER_STATUS[req.query.status] ? req.query.status : '';
  const rows = db.prepare(`
    SELECT u.*, (SELECT group_concat(e.name, ', ') FROM user_entrepreneurs ue JOIN entrepreneurs e ON e.id = ue.entrepreneur_id
                 WHERE ue.user_id = u.id) AS ip_names,
           (SELECT count(*) FROM applications a WHERE a.seller_id = u.id AND a.status IN ('signed','closed')) AS deals
    FROM users u WHERE u.role = 'seller' ${status ? 'AND u.status = ?' : ''}
    ORDER BY CASE u.status WHEN 'pending' THEN 0 ELSE 1 END, u.id DESC`).all(...(status ? [status] : []));
  res.render('admin/sellers', { title: 'Продавцы', rows, status });
});

function readSeller(body, { isNew }) {
  const errors = {};
  const data = { ...u.readPerson(body, errors), email: u.str(body.email, 120) };
  data.ipIds = [].concat(body.ip_ids || []).map(Number).filter(Boolean);
  if (isNew) {
    data.phone = u.normPhone(body.phone);
    if (!u.isPhone(data.phone)) errors.phone = 'Неверный номер';
    else if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(data.phone)) errors.phone = 'Номер уже зарегистрирован';
    data.password = String(body.password || '');
    if (data.password.length < 8) errors.password = 'Минимум 8 символов';
  }
  return { data, errors };
}

router.get('/sellers/new', (req, res) => {
  res.render('admin/seller', { title: 'Новый продавец', seller: null, ips: allIps(), form: { ip_ids: [], password: crypto.randomBytes(6).toString('base64url') } });
});

router.post('/sellers/new', (req, res) => {
  const { data, errors } = readSeller(req.body, { isNew: true });
  if (Object.keys(errors).length) {
    return res.status(400).render('admin/seller', { title: 'Новый продавец', seller: null, ips: allIps(), errors, form: { ...req.body, ip_ids: data.ipIds } });
  }
  const id = db.transaction(() => {
    const info = db.prepare(`INSERT INTO users (role, phone, password_hash, ${PERSON_COLS.join(', ')}, status)
      VALUES ('seller', ?, ?, ${PERSON_COLS.map(() => '?').join(', ')}, 'approved')`)
      .run(data.phone, bcrypt.hashSync(data.password, 10), ...PERSON_COLS.map((c) => data[c]));
    setUserIps(info.lastInsertRowid, data.ipIds);
    return info.lastInsertRowid;
  })();
  u.flash(req, 'ok', `Продавец добавлен и одобрен. Логин: ${u.phoneFmt(data.phone)}, пароль: ${data.password}`);
  res.redirect(`/admin/sellers/${id}`);
});

router.param('sellerId', (req, res, next, id) => {
  req.seller = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'seller'").get(Number(id));
  if (!req.seller) return res.status(404).render('error', { title: 'Не найдено', message: 'Продавец не найден.' });
  next();
});

router.get('/sellers/:sellerId', (req, res) => {
  const s = req.seller;
  const apps = db.prepare('SELECT * FROM applications WHERE seller_id = ? ORDER BY id DESC LIMIT 50').all(s.id);
  res.render('admin/seller', { title: u.fio(s) || 'Продавец', seller: s, ips: allIps(), apps, form: { ...s, ip_ids: userIpIds(s.id) } });
});

router.post('/sellers/:sellerId', (req, res) => {
  const s = req.seller;
  const { data, errors } = readSeller(req.body, { isNew: false });
  if (Object.keys(errors).length) {
    return res.status(400).render('admin/seller', { title: u.fio(s), seller: s, ips: allIps(), apps: [], errors, form: { ...req.body, ip_ids: data.ipIds } });
  }
  db.transaction(() => {
    db.prepare(`UPDATE users SET ${PERSON_COLS.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...PERSON_COLS.map((c) => data[c]), s.id);
    setUserIps(s.id, data.ipIds);
  })();
  u.flash(req, 'ok', 'Данные продавца и привязка ИП сохранены');
  res.redirect(`/admin/sellers/${s.id}`);
});

router.post('/sellers/:sellerId/decision', (req, res) => {
  const s = req.seller;
  const decision = { approve: 'approved', reject: 'rejected', correction: 'correction', block: 'blocked', unblock: 'approved' }[req.body.decision];
  const comment = u.str(req.body.comment, 1000);
  if (!decision) return res.redirect(`/admin/sellers/${s.id}`);
  if (decision === 'correction' && !comment) {
    u.flash(req, 'error', 'Напишите, что нужно исправить');
    return res.redirect(`/admin/sellers/${s.id}`);
  }
  if (decision === 'approved' && !userIpIds(s.id).length) {
    u.flash(req, 'error', 'Перед одобрением прикрепите продавцу хотя бы одного ИП');
    return res.redirect(`/admin/sellers/${s.id}`);
  }
  db.prepare("UPDATE users SET status = ?, admin_comment = ?, updated_at = datetime('now') WHERE id = ?").run(decision, comment || null, s.id);
  u.flash(req, 'ok', `Статус продавца: ${u.USER_STATUS[decision]}`);
  res.redirect(`/admin/sellers/${s.id}`);
});

router.post('/sellers/:sellerId/password', (req, res) => {
  const pass = crypto.randomBytes(6).toString('base64url');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(pass, 10), req.seller.id);
  u.flash(req, 'ok', `Новый пароль продавца: ${pass}`);
  res.redirect(`/admin/sellers/${req.seller.id}`);
});

// ---------- ИП ----------
const IP_COLS = ['name', 'full_name', 'inn', 'ogrnip', 'address', 'bank_name', 'bik', 'account', 'corr_account', 'phone', 'email'];

function readIp(body) {
  const errors = {};
  const d = {};
  for (const c of IP_COLS) d[c] = u.str(body[c], 500);
  for (const c of ['inn', 'ogrnip', 'bik', 'account', 'corr_account']) d[c] = d[c].replace(/\D/g, '');
  d.phone = d.phone ? u.normPhone(d.phone) : '';
  if (!d.name) errors.name = 'Например: ИП Иванов И. И.';
  if (!d.full_name) errors.full_name = 'Укажите полное наименование';
  if (!/^\d{12}$/.test(d.inn)) errors.inn = 'ИНН ИП — 12 цифр';
  if (!/^\d{15}$/.test(d.ogrnip)) errors.ogrnip = 'ОГРНИП — 15 цифр';
  if (!d.address) errors.address = 'Укажите адрес';
  if (!d.bank_name) errors.bank_name = 'Укажите банк';
  if (!/^\d{9}$/.test(d.bik)) errors.bik = 'БИК — 9 цифр';
  if (!/^\d{20}$/.test(d.account)) errors.account = 'Расчётный счёт — 20 цифр';
  if (!/^\d{20}$/.test(d.corr_account)) errors.corr_account = 'Корр. счёт — 20 цифр';
  return { d, errors };
}

router.get('/ips', (req, res) => {
  const rows = db.prepare(`SELECT e.*, (SELECT count(*) FROM user_entrepreneurs ue WHERE ue.entrepreneur_id = e.id) sellers,
    (SELECT count(*) FROM applications a WHERE a.entrepreneur_id = e.id AND a.status IN ('signed','closed')) deals
    FROM entrepreneurs e ORDER BY e.active DESC, e.name`).all();
  res.render('admin/ips', { title: 'ИП и реквизиты', rows });
});

router.get('/ips/new', (req, res) => res.render('admin/ip', { title: 'Новый ИП', ip: null }));

router.post('/ips/new', (req, res) => {
  const { d, errors } = readIp(req.body);
  if (Object.keys(errors).length) return res.status(400).render('admin/ip', { title: 'Новый ИП', ip: null, errors, form: req.body });
  db.prepare(`INSERT INTO entrepreneurs (${IP_COLS.join(', ')}) VALUES (${IP_COLS.map(() => '?').join(', ')})`).run(...IP_COLS.map((c) => d[c]));
  u.flash(req, 'ok', `${d.name} добавлен`);
  res.redirect('/admin/ips');
});

router.param('ipId', (req, res, next, id) => {
  req.ipRow = db.prepare('SELECT * FROM entrepreneurs WHERE id = ?').get(Number(id));
  if (!req.ipRow) return res.status(404).render('error', { title: 'Не найдено', message: 'ИП не найден.' });
  next();
});

router.get('/ips/:ipId', (req, res) => {
  const sellers = db.prepare(`SELECT u.* FROM users u JOIN user_entrepreneurs ue ON ue.user_id = u.id WHERE ue.entrepreneur_id = ?`).all(req.ipRow.id);
  res.render('admin/ip', { title: req.ipRow.name, ip: req.ipRow, sellers, form: req.ipRow });
});

router.post('/ips/:ipId', (req, res) => {
  const { d, errors } = readIp(req.body);
  if (Object.keys(errors).length) return res.status(400).render('admin/ip', { title: req.ipRow.name, ip: req.ipRow, sellers: [], errors, form: req.body });
  db.prepare(`UPDATE entrepreneurs SET ${IP_COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...IP_COLS.map((c) => d[c]), req.ipRow.id);
  u.flash(req, 'ok', 'Реквизиты сохранены. Новые договоры будут оформляться с ними.');
  res.redirect(`/admin/ips/${req.ipRow.id}`);
});

router.post('/ips/:ipId/toggle', (req, res) => {
  db.prepare('UPDATE entrepreneurs SET active = 1 - active WHERE id = ?').run(req.ipRow.id);
  res.redirect(`/admin/ips/${req.ipRow.id}`);
});

// ---------- рассрочки ----------
router.get('/applications', (req, res) => res.redirect('/app/search' + (req.query.status ? `?status=${encodeURIComponent(req.query.status)}` : '')));

router.post('/applications/:appId/override', (req, res) => {
  const a = db.prepare('SELECT * FROM applications WHERE id = ?').get(Number(req.params.appId));
  if (a && a.status === 'declined') {
    db.prepare(`UPDATE applications SET status = 'approved', check_status = 'override', admin_comment = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(u.str(req.body.comment, 1000) || 'Одобрено администратором', a.id);
    u.flash(req, 'ok', 'Заявка одобрена вручную');
  }
  res.redirect(`/app/${req.params.appId}`);
});

router.post('/payments/:pid/toggle', (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(req.params.pid));
  if (!p) return res.redirect('/admin');
  db.transaction(() => {
    db.prepare("UPDATE payments SET paid_at = CASE WHEN paid_at IS NULL THEN datetime('now') ELSE NULL END WHERE id = ?").run(p.id);
    const left = db.prepare('SELECT count(*) c FROM payments WHERE application_id = ? AND paid_at IS NULL').get(p.application_id).c;
    db.prepare(`UPDATE applications SET status = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('signed','closed')`)
      .run(left ? 'signed' : 'closed', p.application_id);
  })();
  res.redirect(`/app/${p.application_id}`);
});

router.post('/applications/:appId/blacklist', (req, res) => {
  const a = db.prepare('SELECT * FROM applications WHERE id = ?').get(Number(req.params.appId));
  if (a) {
    db.prepare(`INSERT INTO blacklist (last_name, first_name, middle_name, birth_date, passport_series, passport_number, phone, reason, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.last_name, a.first_name, a.middle_name, a.birth_date, a.passport_series, a.passport_number, a.phone,
        u.str(req.body.reason, 500) || `Добавлен по договору ${a.number}`, req.user.id);
    u.flash(req, 'ok', 'Клиент добавлен в стоп-лист');
  }
  res.redirect(`/app/${req.params.appId}`);
});

// ---------- стоп-лист ----------
router.get('/blacklist', (req, res) => {
  const rows = db.prepare('SELECT * FROM blacklist ORDER BY id DESC').all();
  res.render('admin/blacklist', { title: 'Стоп-лист', rows });
});

router.post('/blacklist', (req, res) => {
  const b = req.body;
  const row = {
    last_name: u.str(b.last_name, 80), first_name: u.str(b.first_name, 80), middle_name: u.str(b.middle_name, 80),
    birth_date: u.isValidDate(b.birth_date) ? b.birth_date : null,
    passport_series: u.str(b.passport_series).replace(/\D/g, '') || null,
    passport_number: u.str(b.passport_number).replace(/\D/g, '') || null,
    phone: b.phone ? u.normPhone(b.phone) : null,
    reason: u.str(b.reason, 500),
  };
  const enough = row.passport_number || row.phone || (row.last_name && row.first_name && row.birth_date);
  if (!row.reason || !enough) {
    u.flash(req, 'error', 'Укажите причину и паспорт, телефон или ФИО с датой рождения');
    return res.redirect('/admin/blacklist');
  }
  db.prepare(`INSERT INTO blacklist (last_name, first_name, middle_name, birth_date, passport_series, passport_number, phone, reason, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...Object.values(row), req.user.id);
  u.flash(req, 'ok', 'Запись добавлена');
  res.redirect('/admin/blacklist');
});

router.post('/blacklist/:id/delete', (req, res) => {
  db.prepare('DELETE FROM blacklist WHERE id = ?').run(Number(req.params.id));
  res.redirect('/admin/blacklist');
});

// ---------- настройки ----------
const mask = (v) => (v ? `••••${String(v).slice(-4)}` : '');

router.get('/settings', (req, res) => res.render('admin/settings', {
  title: 'Настройки',
  fsspOn: Boolean(process.env.FSSP_API_URL),
  bkiOn: Boolean(process.env.BKI_API_URL),
  ocrYandex: ocr.yandexConfigured(),
  keys: {
    sms_ru_api_id: mask(getSecret('sms_ru_api_id')),
    sms_from: getSecret('sms_from'),
    yandex_api_key: mask(getSecret('yandex_api_key')),
    yandex_folder_id: getSecret('yandex_folder_id'),
  },
  fromEnv: Object.fromEntries(['sms_ru_api_id', 'sms_from', 'yandex_api_key', 'yandex_folder_id'].map((k) => [k, secretFromEnv(k)])),
}));

// Ключи сервисов: пустое поле — оставить как есть, «-» — удалить
router.post('/settings/integrations', (req, res) => {
  for (const key of ['sms_ru_api_id', 'sms_from', 'yandex_api_key', 'yandex_folder_id']) {
    const v = u.str(req.body[key], 200);
    if (!v) continue;
    setSetting(key, v === '-' ? '' : v);
  }
  u.flash(req, 'ok', 'Настройки сервисов сохранены');
  res.redirect('/admin/settings');
});

router.post('/settings/sms-test', async (req, res) => {
  try {
    const bal = await sms.balance();
    const phone = u.normPhone(req.body.phone);
    if (u.isPhone(phone)) {
      await sms.sendSms(phone, 'Рассрочка.Топ: тестовое SMS, сервис подключён.');
      u.flash(req, 'ok', `SMS.ru подключён. Баланс: ${bal.toLocaleString('ru-RU')} ₽. Тестовое SMS отправлено на ${u.phoneFmt(phone)}`);
    } else {
      u.flash(req, 'ok', `SMS.ru подключён. Баланс: ${bal.toLocaleString('ru-RU')} ₽`);
    }
  } catch (e) {
    u.flash(req, 'error', `SMS.ru: ${e.message}`);
  }
  res.redirect('/admin/settings');
});

router.post('/settings', (req, res) => {
  const markup = Number(String(req.body.markup_percent).replace(',', '.'));
  const min = Number(req.body.min_months);
  const max = Number(req.body.max_months);
  if (!(markup >= 0 && markup <= 50) || !Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 36 || min > max) {
    u.flash(req, 'error', 'Проверьте значения: наценка 0–50 %, срок 1–36 мес.');
    return res.redirect('/admin/settings');
  }
  setSetting('markup_percent', markup);
  setSetting('min_months', min);
  setSetting('max_months', max);
  setSetting('support_phone', u.str(req.body.support_phone, 50));
  u.flash(req, 'ok', 'Настройки сохранены');
  res.redirect('/admin/settings');
});

router.post('/settings/password', (req, res) => {
  const { current, password, password2 } = req.body;
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) u.flash(req, 'error', 'Текущий пароль неверен');
  else if (String(password || '').length < 8) u.flash(req, 'error', 'Новый пароль — минимум 8 символов');
  else if (password !== password2) u.flash(req, 'error', 'Пароли не совпадают');
  else {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.user.id);
    u.flash(req, 'ok', 'Пароль изменён');
  }
  res.redirect('/admin/settings');
});

module.exports = router;
