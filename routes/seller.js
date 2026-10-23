const express = require('express');
const { db, getSettings } = require('../lib/db');
const u = require('../lib/util');
const Calc = require('../public/js/calc');
const sms = require('../lib/sms');
const checks = require('../lib/checks');
const crypto = require('crypto');
const QRCode = require('qrcode');
const multer = require('multer');
const { paymentQr } = require('../lib/qr');
const storage = require('../lib/storage');
const payments = require('../lib/payments');
const { CLAIM_STATUS } = require('../lib/claims');
const commission = require('../lib/commission');
const annulments = require('../lib/annulments');
const { addContractPages, MAX_PAGES } = require('./mobile');

const router = express.Router();
router.use(u.requireSeller);

const EMPLOYMENT = {
  employed: 'Работа по найму', ip: 'Индивидуальный предприниматель', self: 'Самозанятый',
  pensioner: 'Пенсионер', student: 'Студент', other: 'Не работает',
};
router.use((req, res, next) => {
  Object.assign(res.locals, {
    EMPLOYMENT, METHOD: payments.METHOD, RECORD_STATUS: payments.RECORD_STATUS, CLAIM_STATUS, daysLabel: payments.daysLabel,
    ANNUL_STATUS: annulments.ANNUL_STATUS, PAYOUT_STATUS: commission.PAYOUT_STATUS, LEDGER_KIND: commission.LEDGER_KIND,
  });
  next();
});

const STEPS = ['Товар', 'Анкета', 'SMS и согласие', 'Проверка', 'Договор'];

// ИП, от имени которых пользователь может оформлять рассрочку
function availableIps(user) {
  if (user.role === 'admin') return db.prepare('SELECT * FROM entrepreneurs WHERE active = 1 ORDER BY name').all();
  return db.prepare(`SELECT e.* FROM entrepreneurs e JOIN user_entrepreneurs ue ON ue.entrepreneur_id = e.id
                     WHERE ue.user_id = ? AND e.active = 1 ORDER BY e.name`).all(user.id);
}

function readProduct(body, user, errors) {
  const s = getSettings();
  const p = {
    product_name: u.str(body.product_name, 300),
    price: u.rubToKop(body.product_price),
    down: body.down_payment ? u.rubToKop(body.down_payment) : 0,
    months: Number(body.months),
    entrepreneur_id: Number(body.entrepreneur_id),
  };
  if (!p.product_name) errors.product_name = 'Укажите товар';
  if (!Number.isFinite(p.price) || p.price < 100 * 100) errors.product_price = 'Минимальная стоимость — 100 ₽';
  else if (p.price > 10_000_000 * 100) errors.product_price = 'Слишком большая сумма';
  if (!Number.isFinite(p.down) || p.down < 0) errors.down_payment = 'Неверная сумма';
  else if (p.down >= p.price) errors.down_payment = 'Первый взнос должен быть меньше стоимости';
  if (!Number.isInteger(p.months) || p.months < s.minMonths || p.months > s.maxMonths) {
    errors.months = `Срок от ${s.minMonths} до ${s.maxMonths} мес.`;
  }
  if (!availableIps(user).some((i) => i.id === p.entrepreneur_id)) errors.entrepreneur_id = 'Выберите ИП';
  p.calc = errors.product_price || errors.months ? null
    : Calc.calculate({ price: p.price, downPayment: p.down, months: p.months, markupPercent: s.markupPercent });
  return p;
}

function productValues(p) {
  const c = p.calc;
  return [p.entrepreneur_id, p.product_name, p.price, p.down, p.months, c.markupPercent, c.markup, c.total, c.financed, c.monthly];
}

function currentStep(a) {
  if (!a.client_filled_at) return 2;
  if (!a.pd_consent_signed_at) return 3;
  if (!a.check_status) return 4;
  return 5;
}

const editable = (a) => ['draft', 'approved', 'declined'].includes(a.status);

// ---------- создать заявку ----------
router.get('/new', (req, res) => {
  const ips = availableIps(req.user);
  res.render('seller/new', { title: 'Создать заявку', ips, form: { months: 3, entrepreneur_id: ips[0] && ips[0].id } });
});

router.post('/new', (req, res) => {
  const errors = {};
  const p = readProduct(req.body, req.user, errors);
  if (Object.keys(errors).length) {
    return res.status(400).render('seller/new', { title: 'Создать заявку', ips: availableIps(req.user), errors, form: req.body });
  }
  const id = db.transaction(() => {
    const info = db.prepare(`INSERT INTO applications (seller_id, entrepreneur_id, product_name, product_price, down_payment, months,
        markup_percent, markup_amount, total_amount, financed_amount, monthly_payment, pay_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.user.id, ...productValues(p), crypto.randomBytes(18).toString('hex'));
    const yy = String(new Date().getFullYear()).slice(2);
    db.prepare('UPDATE applications SET number = ? WHERE id = ?')
      .run(`РТ-${yy}-${String(info.lastInsertRowid).padStart(6, '0')}`, info.lastInsertRowid);
    return info.lastInsertRowid;
  })();
  res.redirect(`/app/${id}`);
});

// ---------- калькулятор ----------
router.get('/calculator', (req, res) => {
  res.render('seller/calculator', { title: 'Калькулятор' });
});

// ---------- поиск ----------
router.get('/search', (req, res) => {
  const q = u.str(req.query.q, 100);
  const status = u.str(req.query.status, 20);
  const where = [];
  const params = [];
  if (req.user.role !== 'admin') { where.push('a.seller_id = ?'); params.push(req.user.id); }
  if (status && u.APP_STATUS[status]) { where.push('a.status = ?'); params.push(status); }
  if (q) {
    const or = ['lower_ru(a.number) LIKE ?'];
    params.push(`%${q.toLowerCase()}%`);
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 4 && digits.length === q.replace(/[\s()+-]/g, '').length) {
      or.push("a.phone LIKE ?", "(a.passport_series || a.passport_number) LIKE ?");
      params.push(`%${digits}%`, `%${digits}%`);
    }
    const words = q.split(/\s+/).filter(Boolean);
    or.push('(' + words.map(() => "lower_ru(coalesce(a.last_name,'') || ' ' || coalesce(a.first_name,'') || ' ' || coalesce(a.middle_name,'')) LIKE ?").join(' AND ') + ')');
    params.push(...words.map((w) => `%${w.toLowerCase().replace(/ё/g, 'е')}%`));
    where.push('(' + or.join(' OR ') + ')');
  }
  const rows = db.prepare(`
    SELECT a.*, e.name AS ip_name, s.last_name AS s_last, s.first_name AS s_first, s.middle_name AS s_middle,
      (SELECT count(*) FROM documents d WHERE d.application_id = a.id AND d.kind = 'contract_page') AS scan_pages,
      (SELECT count(*) FROM payments p WHERE p.application_id = a.id AND p.paid_amount < p.amount AND p.due_date < date('now')) AS overdue
    FROM applications a JOIN entrepreneurs e ON e.id = a.entrepreneur_id JOIN users s ON s.id = a.seller_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.id DESC LIMIT 200`).all(...params);
  res.render('seller/search', { title: req.user.role === 'admin' ? 'Рассрочки' : 'Поиск', q, status, rows });
});

// ---------- вознаграждение продавца и вывод средств ----------
router.get('/rewards', (req, res) => {
  const sellerId = req.user.role === 'admin' ? Number(req.query.seller) || null : req.user.id;
  if (!sellerId) return res.redirect('/admin/payouts');
  const seller = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'seller'").get(sellerId);
  if (!seller) return res.redirect('/admin/payouts');
  const ledger = db.prepare(`SELECT l.*, a.number, a.months, a.total_amount, a.seller_commission_percent, a.last_name, a.first_name, a.middle_name
    FROM seller_ledger l LEFT JOIN applications a ON a.id = l.application_id WHERE l.seller_id = ? ORDER BY l.id DESC LIMIT 300`).all(sellerId);
  const payouts = db.prepare('SELECT * FROM payouts WHERE seller_id = ? ORDER BY id DESC LIMIT 100').all(sellerId);
  res.render('seller/rewards', { title: 'Вознаграждение', seller, bal: commission.balance(sellerId), ledger, payouts });
});

router.post('/rewards/details', (req, res) => {
  if (req.user.role !== 'seller') return res.redirect('/app/rewards');
  db.prepare('UPDATE users SET payout_details = ? WHERE id = ?').run(u.str(req.body.payout_details, 300) || null, req.user.id);
  u.flash(req, 'ok', 'Реквизиты для выплаты сохранены');
  res.redirect('/app/rewards');
});

router.post('/rewards/payout', (req, res) => {
  if (req.user.role !== 'seller') return res.redirect('/app/rewards');
  const bal = commission.balance(req.user.id);
  const amount = u.rubToKop(req.body.amount);
  const details = u.str(req.body.payout_details, 300) || req.user.payout_details;
  if (!details) u.flash(req, 'error', 'Укажите номер карты или телефон для перевода по СБП');
  else if (!(amount > 0)) u.flash(req, 'error', 'Укажите сумму');
  else if (amount > bal.available) u.flash(req, 'error', `Доступно к выводу ${u.moneyFmt(bal.available)}`);
  else {
    db.prepare('UPDATE users SET payout_details = ? WHERE id = ?').run(details, req.user.id);
    commission.requestPayout(req.user.id, amount, details);
    u.flash(req, 'ok', `Заявка на вывод ${u.moneyFmt(amount)} отправлена администратору`);
  }
  res.redirect('/app/rewards');
});

// ---------- платежи: сроки, просрочки, оплаты на подтверждении ----------
const PAY_FILTERS = { all: 'Все неоплаченные', overdue: 'Просроченные', week: 'Ближайшие 7 дней', month: 'Ближайшие 30 дней' };

router.get('/payments', (req, res) => {
  const filter = PAY_FILTERS[req.query.f] ? req.query.f : 'all';
  const sellerId = req.user.role === 'admin' ? null : req.user.id;
  const rows = payments.upcoming({ sellerId, filter: filter === 'all' ? null : filter });
  const pending = db.prepare(`
    SELECT r.*, a.number, a.last_name, a.first_name, a.middle_name, u.last_name AS s_last, u.first_name AS s_first, u.middle_name AS s_middle
    FROM payment_records r JOIN applications a ON a.id = r.application_id LEFT JOIN users u ON u.id = r.created_by
    WHERE r.status = 'pending' ${sellerId ? 'AND a.seller_id = ?' : ''} ORDER BY r.id`).all(...(sellerId ? [sellerId] : []));
  const counts = {};
  for (const f of Object.keys(PAY_FILTERS)) counts[f] = payments.upcoming({ sellerId, filter: f === 'all' ? null : f }).length;
  res.render('seller/payments', { title: 'Платежи', rows, pending, filter, PAY_FILTERS, counts, today: payments.today() });
});

// ---------- претензии ----------
router.get('/claims', (req, res) => {
  const sellerId = req.user.role === 'admin' ? null : req.user.id;
  const status = CLAIM_STATUS[req.query.status] ? req.query.status : '';
  const where = [];
  const params = [];
  if (sellerId) { where.push('a.seller_id = ?'); params.push(sellerId); }
  if (status) { where.push('c.status = ?'); params.push(status); }
  else where.push("c.status <> 'closed'");
  const rows = db.prepare(`
    SELECT c.*, a.number AS app_number, a.id AS app_id, a.last_name, a.first_name, a.middle_name, a.phone, e.name AS ip_name
    FROM claims c JOIN applications a ON a.id = c.application_id JOIN entrepreneurs e ON e.id = a.entrepreneur_id
    WHERE ${where.join(' AND ')} ORDER BY CASE c.status WHEN 'new' THEN 0 WHEN 'handed' THEN 1 ELSE 2 END, c.id DESC`).all(...params);
  res.render('seller/claims', { title: 'Претензии', rows, status });
});

function loadClaim(req, res) {
  const c = db.prepare('SELECT * FROM claims WHERE id = ?').get(Number(req.params.cid));
  const a = c && db.prepare('SELECT * FROM applications WHERE id = ?').get(c.application_id);
  if (!c || (req.user.role !== 'admin' && a.seller_id !== req.user.id)) {
    res.status(404).render('error', { title: 'Не найдено', message: 'Претензия не найдена.' });
    return null;
  }
  return { c, a };
}

router.get('/claims/:cid', async (req, res) => {
  const found = loadClaim(req, res);
  if (!found) return;
  const { c, a } = found;
  const ip = db.prepare('SELECT * FROM entrepreneurs WHERE id = ?').get(a.entrepreneur_id);
  const details = JSON.parse(c.details);
  const qr = await paymentQr(ip, { sum: c.overdue_amount, purpose: `Погашение задолженности по договору рассрочки ${a.number}`, payer: a });
  const paidTotal = db.prepare('SELECT coalesce(sum(paid_amount), 0) s FROM payments WHERE application_id = ?').get(a.id).s + a.down_payment;
  res.render('docs/claim', { title: `Претензия ${c.number}`, c, a, ip, details, qr, paidTotal, backUrl: `/app/${a.id}` });
});

router.post('/claims/:cid/handed', (req, res) => {
  const found = loadClaim(req, res);
  if (!found) return;
  db.prepare("UPDATE claims SET status = 'handed', handed_at = datetime('now'), handed_by = ? WHERE id = ? AND status = 'new'").run(req.user.id, found.c.id);
  u.flash(req, 'ok', 'Отмечено: претензия передана руководителю магазина');
  res.redirect(req.body.back === 'list' ? '/app/claims' : `/app/${found.a.id}`);
});

router.post('/claims/:cid/delivered', (req, res) => {
  const found = loadClaim(req, res);
  if (!found) return;
  db.prepare("UPDATE claims SET status = 'delivered', delivered_at = datetime('now'), delivered_by = ? WHERE id = ? AND status IN ('new','handed')").run(req.user.id, found.c.id);
  u.flash(req, 'ok', 'Отмечено: претензия вручена клиенту');
  res.redirect(req.body.back === 'list' ? '/app/claims' : `/app/${found.a.id}`);
});

// ---------- карточка заявки ----------
router.param('id', (req, res, next, id) => {
  const a = db.prepare('SELECT * FROM applications WHERE id = ?').get(Number(id));
  if (!a || (req.user.role !== 'admin' && a.seller_id !== req.user.id)) {
    return res.status(404).render('error', { title: 'Не найдено', message: 'Заявка не найдена.' });
  }
  req.app_ = a;
  req.ip_ = db.prepare('SELECT * FROM entrepreneurs WHERE id = ?').get(a.entrepreneur_id);
  res.locals.docs = db.prepare('SELECT * FROM documents WHERE application_id = ? ORDER BY id').all(a.id);
  next();
});

function scheduleFor(a) {
  const saved = db.prepare('SELECT * FROM payments WHERE application_id = ? ORDER BY n').all(a.id);
  if (saved.length) return saved;
  const calc = Calc.calculate({ price: a.product_price, downPayment: a.down_payment, months: a.months, markupPercent: a.markup_percent });
  return Calc.schedule(calc, new Date()).map((p) => ({ n: p.n, due_date: u.isoDate(p.date), amount: p.amount }));
}

router.get('/:id', async (req, res) => {
  const a = req.app_;
  const done = currentStep(a);
  let step = Number(req.query.step) || done;
  if (step > done || step < 1 || step > 5) step = done;
  if (['signed', 'closed', 'annulled'].includes(a.status)) step = 6; // финальный экран

  const seller = db.prepare('SELECT * FROM users WHERE id = ?').get(a.seller_id);
  const t = payments.today();
  const schedule = scheduleFor(a).map((p) => (p.id ? payments.paymentState(p, t) : p));
  const next = schedule.find((p) => p.id ? p.remaining > 0 : !p.paid_at);
  const qr = (step >= 5 && req.ip_)
    ? await paymentQr(req.ip_, {
      sum: next ? (next.remaining || next.amount) : a.monthly_payment,
      purpose: `Оплата по договору рассрочки ${a.number}`,
      payer: a,
    })
    : null;

  const after = step === 6 ? {
    records: db.prepare(`SELECT r.*, u.last_name AS u_last, u.first_name AS u_first, u.middle_name AS u_middle
      FROM payment_records r LEFT JOIN users u ON u.id = r.created_by WHERE r.application_id = ? ORDER BY r.paid_on DESC, r.id DESC`).all(a.id),
    notifications: db.prepare('SELECT * FROM notifications WHERE application_id = ? ORDER BY id DESC LIMIT 20').all(a.id),
    claims: db.prepare('SELECT * FROM claims WHERE application_id = ? ORDER BY id DESC').all(a.id),
    debt: payments.debt(a.id, t),
    payUrl: `${u.publicBase(req)}/pay/${a.pay_token}`,
    paidTotal: schedule.reduce((sum, p) => sum + (p.paid_amount || 0), 0),
    today: t,
    annuls: db.prepare(`SELECT n.*, u.last_name AS u_last, u.first_name AS u_first, u.middle_name AS u_middle
      FROM annulments n LEFT JOIN users u ON u.id = n.requested_by WHERE n.application_id = ? ORDER BY n.id DESC`).all(a.id),
  } : {};
  res.render('seller/application', {
    title: `Заявка ${a.number}`, a, ip: req.ip_, seller, steps: STEPS, step, done, ...after,
    contractPages: res.locals.docs.filter((d) => d.kind === 'contract_page'),
    ips: availableIps(req.user), schedule, qr, editable: editable(a),
    checkResult: a.check_result ? JSON.parse(a.check_result) : null,
    fsspConfigured: checks.fsspConfigured(), fsspUrl: checks.FSSP_MANUAL_URL,
    devCode: req.session.devCode && req.session.devCode.appId === a.id ? req.session.devCode : null,
    form: { ...a, product_price: a.product_price / 100, down_payment: a.down_payment ? a.down_payment / 100 : '',
      monthly_income: a.monthly_income != null ? a.monthly_income / 100 : '' },
  });
});

function back(res, a, step) { res.redirect(`/app/${a.id}?step=${step}`); }

router.post('/:id/product', (req, res) => {
  const a = req.app_;
  if (!editable(a)) return back(res, a, 1);
  const errors = {};
  const p = readProduct(req.body, a.seller_id === req.user.id ? req.user : { role: 'admin' }, errors);
  if (Object.keys(errors).length) {
    u.flash(req, 'error', Object.values(errors).join('. '));
    return back(res, a, 1);
  }
  db.prepare(`UPDATE applications SET entrepreneur_id = ?, product_name = ?, product_price = ?, down_payment = ?, months = ?,
      markup_percent = ?, markup_amount = ?, total_amount = ?, financed_amount = ?, monthly_payment = ?, updated_at = datetime('now')
    WHERE id = ?`).run(...productValues(p), a.id);
  u.flash(req, 'ok', 'Условия сохранены');
  res.redirect(`/app/${a.id}`);
});

router.post('/:id/client', (req, res) => {
  const a = req.app_;
  if (!editable(a)) return back(res, a, 2);
  const b = req.body;
  const errors = {};
  const c = {
    ...u.readPerson(b, errors),
    gender: b.gender === 'f' ? 'f' : b.gender === 'm' ? 'm' : '',
    birth_place: u.str(b.birth_place, 300),
    phone: u.normPhone(b.phone),
    email: u.str(b.email, 120),
    fact_address: b.same_address ? u.str(b.reg_address, 500) : u.str(b.fact_address, 500),
    marital_status: u.str(b.marital_status, 30),
    dependents: Math.max(0, Math.min(20, Number(b.dependents) || 0)),
    employment_type: EMPLOYMENT[b.employment_type] ? b.employment_type : '',
    work_place: u.str(b.work_place, 300),
    work_position: u.str(b.work_position, 200),
    work_address: u.str(b.work_address, 500),
    work_phone: b.work_phone ? u.normPhone(b.work_phone) : '',
    work_experience: u.str(b.work_experience, 50),
    monthly_income: u.rubToKop(b.monthly_income),
    contact_name: u.str(b.contact_name, 200),
    contact_phone: u.normPhone(b.contact_phone),
    contact_relation: u.str(b.contact_relation, 50),
  };
  if (!c.gender) errors.gender = 'Укажите пол';
  if (!c.birth_place) errors.birth_place = 'Укажите место рождения';
  if (!u.isPhone(c.phone)) errors.phone = 'Неверный номер';
  if (c.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) errors.email = 'Неверный e-mail';
  if (!c.fact_address) errors.fact_address = 'Укажите адрес проживания';
  if (!c.employment_type) errors.employment_type = 'Укажите занятость';
  if (['employed', 'ip'].includes(c.employment_type)) {
    if (!c.work_place) errors.work_place = 'Укажите место работы';
    if (!c.work_position && c.employment_type === 'employed') errors.work_position = 'Укажите должность';
  }
  if (!Number.isFinite(c.monthly_income) || c.monthly_income <= 0) errors.monthly_income = 'Укажите доход';
  if (!c.contact_name) errors.contact_name = 'Укажите контактное лицо';
  if (!u.isPhone(c.contact_phone)) errors.contact_phone = 'Неверный номер';
  else if (c.contact_phone === c.phone) errors.contact_phone = 'Номер должен отличаться от номера клиента';

  if (Object.keys(errors).length) {
    const seller = db.prepare('SELECT * FROM users WHERE id = ?').get(a.seller_id);
    return res.status(400).render('seller/application', {
      title: `Заявка ${a.number}`, a, ip: req.ip_, seller, steps: STEPS, step: 2, done: currentStep(a),
      ips: availableIps(req.user), schedule: [], qr: null, editable: true, checkResult: null, devCode: null,
      fsspConfigured: checks.fsspConfigured(), fsspUrl: checks.FSSP_MANUAL_URL, errors, form: b,
    });
  }

  const cols = Object.keys(c);
  const phoneChanged = a.phone && a.phone !== c.phone;
  db.prepare(`UPDATE applications SET ${cols.map((k) => `${k} = ?`).join(', ')},
      client_filled_at = coalesce(client_filled_at, datetime('now')),
      ${phoneChanged ? 'phone_verified_at = NULL, pd_consent_signed_at = NULL,' : ''}
      check_status = NULL, check_result = NULL, checked_at = NULL, status = 'draft', updated_at = datetime('now')
    WHERE id = ?`).run(...cols.map((k) => c[k]), a.id);
  res.redirect(`/app/${a.id}`);
});

// ---------- SMS ----------
router.post('/:id/sms', async (req, res) => {
  const a = req.app_;
  const purpose = req.body.purpose === 'contract' ? 'contract' : 'consent';
  const step = purpose === 'contract' ? 5 : 3;
  if (!a.phone) return back(res, a, 2);
  if (!u.rateLimit(`sms:${a.id}`, 6, 3600e3)) {
    u.flash(req, 'error', 'Слишком много SMS по этой заявке. Попробуйте позже.');
    return back(res, a, step);
  }
  const text = purpose === 'contract'
    ? `Код {code} - подписание договора рассрочки ${a.number} на ${u.moneyFmt(a.total_amount).replace(' ', ' ')}. Никому не сообщайте код.`
    : 'Код {code} - подтверждение номера и согласие на обработку персональных данных (Рассрочка.Топ). Никому не сообщайте код.';
  try {
    const devCode = await sms.sendCode({ phone: a.phone, purpose, applicationId: a.id, text });
    req.session.devCode = devCode ? { appId: a.id, purpose, code: devCode } : null;
    u.flash(req, 'ok', `Код отправлен на ${u.phoneFmt(a.phone)}`);
  } catch (e) {
    u.flash(req, 'error', e.message);
  }
  back(res, a, step);
});

router.post('/:id/consent', (req, res) => {
  const a = req.app_;
  if (!editable(a)) return back(res, a, 3);
  if (!u.rateLimit(`code:${a.id}`, 15, 3600e3)) {
    u.flash(req, 'error', 'Слишком много попыток');
    return back(res, a, 3);
  }
  const r = sms.verifyCode({ phone: a.phone, purpose: 'consent', applicationId: a.id, code: req.body.code });
  if (!r.ok) {
    u.flash(req, 'error', r.error);
    return back(res, a, 3);
  }
  db.prepare(`UPDATE applications SET phone_verified_at = datetime('now'), pd_consent_signed_at = datetime('now'),
              pd_consent_ip = ?, updated_at = datetime('now') WHERE id = ?`).run(req.ip, a.id);
  req.session.devCode = null;
  u.flash(req, 'ok', 'Телефон подтверждён, согласие на обработку персональных данных подписано');
  res.redirect(`/app/${a.id}`);
});

// ---------- проверка по базам ----------
router.post('/:id/check', async (req, res) => {
  const a = req.app_;
  if (!editable(a) || !a.pd_consent_signed_at) return back(res, a, 4);
  const manual = Boolean(req.body.fssp_manual);
  if (!checks.fsspConfigured() && !manual) {
    u.flash(req, 'error', 'Проверьте клиента на сайте ФССП и отметьте результат');
    return back(res, a, 4);
  }
  const result = await checks.runChecks(a, { fsspManualConfirmed: manual });
  db.prepare(`UPDATE applications SET check_status = ?, check_result = ?, checked_at = datetime('now'), status = ?,
              updated_at = datetime('now') WHERE id = ?`)
    .run(result.status, JSON.stringify(result), result.status === 'clean' ? 'approved' : 'declined', a.id);
  res.redirect(`/app/${a.id}?step=${result.status === 'clean' ? 5 : 4}`);
});

// ---------- подписание договора ----------
router.post('/:id/sign', (req, res) => {
  const a = req.app_;
  if (a.status !== 'approved') {
    u.flash(req, 'error', 'Договор можно подписать только по одобренной заявке');
    return back(res, a, 5);
  }
  if (!req.body.client_read) {
    u.flash(req, 'error', 'Подтвердите, что клиент ознакомлен с договором и графиком платежей');
    return back(res, a, 5);
  }
  const r = sms.verifyCode({ phone: a.phone, purpose: 'contract', applicationId: a.id, code: req.body.code });
  if (!r.ok) {
    u.flash(req, 'error', r.error);
    return back(res, a, 5);
  }
  const calc = Calc.calculate({ price: a.product_price, downPayment: a.down_payment, months: a.months, markupPercent: a.markup_percent });
  const sched = Calc.schedule(calc, new Date());
  db.transaction(() => {
    db.prepare('DELETE FROM payments WHERE application_id = ?').run(a.id);
    const ins = db.prepare('INSERT INTO payments (application_id, n, due_date, amount) VALUES (?, ?, ?, ?)');
    for (const p of sched) ins.run(a.id, p.n, u.isoDate(p.date), p.amount);
    db.prepare(`UPDATE applications SET status = 'signed', contract_signed_at = datetime('now'), contract_sign_ip = ?,
                first_payment_date = ?, updated_at = datetime('now') WHERE id = ?`).run(req.ip, u.isoDate(sched[0].date), a.id);
  })();
  req.session.devCode = null;
  commission.accrue(db.prepare('SELECT * FROM applications WHERE id = ?').get(a.id));
  sms.notify({
    applicationId: a.id, kind: 'signed', phone: a.phone,
    text: `Рассрочка ${a.number} оформлена: ${a.months} мес, платёж ${u.moneyFmt(a.monthly_payment).replace('\u00a0', ' ')}, первый до ${u.dateFmt(u.isoDate(sched[0].date))}. График и оплата: ${u.publicBase(req)}/pay/${a.pay_token}`,
  });
  res.redirect(`/app/${a.id}`);
});

router.post('/:id/cancel', (req, res) => {
  const a = req.app_;
  if (editable(a)) {
    db.prepare("UPDATE applications SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(a.id);
    u.flash(req, 'ok', 'Заявка отменена');
  }
  res.redirect(`/app/${a.id}?step=1`);
});

// ---------- фото документов с телефона по QR-коду ----------
const SCAN_TTL_MS = 30 * 60 * 1000;

async function scanSession(req, res, purpose) {
  const token = crypto.randomBytes(24).toString('base64url');
  const info = db.prepare(`INSERT INTO scan_sessions (token, application_id, created_by, expires_at, created_at, purpose)
                           VALUES (?, ?, ?, ?, ?, ?)`).run(token, req.app_.id, req.user.id, Date.now() + SCAN_TTL_MS, Date.now(), purpose);
  const url = `${u.publicBase(req)}/m/${token}`;
  const qr = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 260 });
  res.json({ id: info.lastInsertRowid, url, qr });
}

router.post('/:id/scan', (req, res) => {
  if (!editable(req.app_)) return res.status(409).json({ error: 'Заявка закрыта для изменений' });
  return scanSession(req, res, 'passport');
});

const isSigned = (a) => a.status === 'signed' || a.status === 'closed';

// ---------- аннулирование: продавец отправляет запрос, администратор решает ----------
router.post('/:id/annul', (req, res) => {
  const a = req.app_;
  const reason = u.str(req.body.reason, 1000);
  if (reason.length < 5) {
    u.flash(req, 'error', 'Опишите причину аннулирования');
    return res.redirect(`/app/${a.id}`);
  }
  const r = annulments.request(a, reason, req.user.id);
  if (r.error) u.flash(req, 'error', r.error);
  else if (req.user.role === 'admin') {
    annulments.approve(r.id, req.user.id, 'Аннулировано администратором');
    u.flash(req, 'ok', 'Рассрочка аннулирована');
  } else u.flash(req, 'ok', 'Запрос на аннулирование отправлен администратору');
  res.redirect(`/app/${a.id}`);
});

router.post('/:id/contract-scan', (req, res) => {
  if (!isSigned(req.app_)) return res.status(409).json({ error: 'Скан загружается после подписания договора' });
  return scanSession(req, res, 'contract');
});

// загрузка скана с компьютера: фото или PDF
const deskUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: MAX_PAGES } });
router.post('/:id/contract-files', (req, res, next) => {
  deskUpload.array('files', MAX_PAGES)(req, res, (err) => {
    if (err) { u.flash(req, 'error', err.code === 'LIMIT_FILE_SIZE' ? 'Файл больше 20 МБ' : 'Ошибка загрузки файла'); return res.redirect(`/app/${req.app_.id}#contract-scan`); }
    const a = req.app_;
    const files = req.files || [];
    if (!isSigned(a) || !files.length) { u.flash(req, 'error', 'Выберите файлы скана договора'); return res.redirect(`/app/${a.id}#contract-scan`); }
    if (files.some((f) => !storage.fileType(f.buffer))) { u.flash(req, 'error', 'Поддерживаются только JPEG, PNG и PDF'); return res.redirect(`/app/${a.id}#contract-scan`); }
    addContractPages(a.id, files.map((f) => f.buffer), req.user.id);
    u.flash(req, 'ok', `Загружено файлов: ${files.length}`);
    res.redirect(`/app/${a.id}#contract-scan`);
  });
});

// ---------- оплаты ----------
router.post('/:id/payments', (req, res) => {
  const a = req.app_;
  const amount = u.rubToKop(req.body.amount);
  const paidOn = u.isValidDate(req.body.paid_on) ? req.body.paid_on : null;
  const method = ['cash', 'card', 'other', 'bank'].includes(req.body.method) ? req.body.method : 'cash';
  const isAdmin = req.user.role === 'admin';
  if (!isSigned(a)) u.flash(req, 'error', 'Оплаты принимаются только по оформленной рассрочке');
  else if (!(amount > 0)) u.flash(req, 'error', 'Укажите сумму оплаты');
  else if (!paidOn || paidOn > payments.today()) u.flash(req, 'error', 'Укажите дату оплаты (не позже сегодняшней)');
  else if (!isAdmin && method === 'bank') u.flash(req, 'error', 'Банковские переводы зачитываются из выписки');
  else {
    payments.addRecord({
      applicationId: a.id, amount, paidOn, method, status: isAdmin ? 'confirmed' : 'pending',
      comment: u.str(req.body.comment, 500), userId: req.user.id,
    });
    u.flash(req, 'ok', isAdmin ? 'Оплата внесена и учтена в графике' : 'Оплата отправлена администратору на подтверждение. В графике она появится после проверки.');
  }
  res.redirect(`/app/${a.id}#payments`);
});

router.get('/:id/scan/:sid', (req, res) => {
  const s = db.prepare('SELECT * FROM scan_sessions WHERE id = ? AND application_id = ?').get(Number(req.params.sid), req.app_.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.set('Cache-Control', 'no-store');
  res.json({
    status: s.status === 'waiting' && s.expires_at < Date.now() ? 'expired' : s.status,
    result: s.result ? JSON.parse(s.result) : null,
    error: s.error,
    docs: res.locals.docs.map((d) => ({ id: d.id, kind: d.kind, url: `/app/${req.app_.id}/docs/${d.id}` })),
  });
});

router.get('/:id/docs/:docId', (req, res) => {
  const d = res.locals.docs.find((x) => x.id === Number(req.params.docId));
  if (!d) return res.status(404).end();
  let body;
  try { body = storage.read(d.file); } catch (e) { console.error('Файл не прочитан:', d.file, e.message); return res.status(500).end(); }
  // имя файла с кириллицей передаётся по RFC 5987, латинское — для старых браузеров
  const ext = d.mime === 'application/pdf' ? 'pdf' : d.mime === 'image/png' ? 'png' : 'jpg';
  const name = `${req.app_.number}-${d.kind}${d.page ? '-' + d.page : ''}.${ext}`;
  res.set({
    'Cache-Control': 'private, no-store',
    'Content-Type': d.mime,
    'Content-Disposition': `inline; filename="${d.kind}${d.page ? '-' + d.page : ''}.${ext}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  res.send(body);
});

// ---------- документы для печати ----------
router.get('/:id/contract', async (req, res) => {
  const a = req.app_;
  if (!a.client_filled_at) return back(res, a, 2);
  const schedule = scheduleFor(a);
  const qr = await paymentQr(req.ip_, { purpose: `Оплата по договору рассрочки ${a.number}`, payer: a });
  const seller = db.prepare('SELECT * FROM users WHERE id = ?').get(a.seller_id);
  res.render('docs/contract', { title: `Договор ${a.number}`, a, ip: req.ip_, schedule, qr, seller });
});

router.get('/:id/consent', (req, res) => {
  const a = req.app_;
  if (!a.client_filled_at) return back(res, a, 2);
  res.render('docs/consent', { title: `Согласие на обработку ПД — ${a.number}`, a, ip: req.ip_ });
});

module.exports = router;
