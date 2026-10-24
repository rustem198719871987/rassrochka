const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, setSetting, getSecret, secretFromEnv } = require('../lib/db');
const sms = require('../lib/sms');
const ocr = require('../lib/ocr');
const u = require('../lib/util');
const multer = require('multer');
const payments = require('../lib/payments');
const statement = require('../lib/statement');
const storage = require('../lib/storage');
const jobs = require('../lib/jobs');
const commission = require('../lib/commission');
const annulments = require('../lib/annulments');
const analytics = require('../lib/analytics');
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
    overdue: one(`SELECT count(*) c, coalesce(sum(p.amount - p.paid_amount),0) s FROM payments p JOIN applications a ON a.id = p.application_id
                  WHERE a.status = 'signed' AND p.paid_amount < p.amount AND p.due_date < ?`, payments.today()),
    records: one("SELECT count(*) c, coalesce(sum(amount),0) s FROM payment_records WHERE status = 'pending'"),
    claims: one("SELECT count(*) c, coalesce(sum(overdue_amount),0) s FROM claims WHERE status IN ('new','handed')"),
    annuls: one("SELECT count(*) c FROM annulments WHERE status = 'pending'").c,
    payouts: one("SELECT count(*) c, coalesce(sum(amount),0) s FROM payouts WHERE status = 'requested'"),
    noScan: one(`SELECT count(*) c FROM applications a WHERE a.status IN ('signed','closed')
                 AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.application_id = a.id AND d.kind = 'contract_page')`).c,
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

// ---------- оплаты: подтверждение наличных, аннулирование ----------
function backTo(req, res, fallback) {
  res.redirect(req.body.back === 'payments' ? '/app/payments' : fallback);
}

router.post('/records/:rid/approve', (req, res) => {
  const r = payments.decide(Number(req.params.rid), { approve: true, adminId: req.user.id, comment: u.str(req.body.comment, 500) });
  u.flash(req, r ? 'ok' : 'error', r ? 'Оплата подтверждена и учтена в графике' : 'Оплата уже обработана');
  backTo(req, res, r ? `/app/${r.application_id}#payments` : '/app/payments');
});

router.post('/records/:rid/reject', (req, res) => {
  const comment = u.str(req.body.comment, 500);
  const pending = db.prepare("SELECT * FROM payment_records WHERE id = ? AND status = 'pending'").get(Number(req.params.rid));
  if (pending && !comment) {
    u.flash(req, 'error', 'Укажите причину отклонения — её увидит продавец');
    return backTo(req, res, `/app/${pending.application_id}#payments`);
  }
  const r = payments.decide(Number(req.params.rid), { approve: false, adminId: req.user.id, comment });
  u.flash(req, r ? 'ok' : 'error', r ? 'Оплата отклонена' : 'Оплата уже обработана');
  backTo(req, res, r ? `/app/${r.application_id}#payments` : '/app/payments');
});

router.post('/records/:rid/cancel', (req, res) => {
  const r = payments.cancel(Number(req.params.rid), { adminId: req.user.id, comment: u.str(req.body.comment, 500) });
  u.flash(req, r ? 'ok' : 'error', r ? 'Оплата аннулирована, график пересчитан' : 'Оплата не найдена');
  res.redirect(r ? `/app/${r.application_id}#payments` : '/app/payments');
});

// ---------- документы: удалить ошибочно загруженную страницу скана ----------
router.post('/documents/:docId/delete', (req, res) => {
  const d = db.prepare("SELECT * FROM documents WHERE id = ? AND kind = 'contract_page'").get(Number(req.params.docId));
  if (!d) return res.redirect('/app/search');
  db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
  storage.remove(d.file);
  u.flash(req, 'ok', `Страница ${d.page} удалена`);
  res.redirect(`/app/${d.application_id}#contract-scan`);
});

// ---------- банковские выписки ----------
const stmtUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

router.get('/statements', (req, res) => {
  const uploads = db.prepare(`SELECT s.*, (SELECT count(*) FROM bank_transactions t WHERE t.upload_id = s.id AND t.status IN ('suggested','unmatched')) AS open
                              FROM statement_uploads s ORDER BY s.id DESC LIMIT 50`).all();
  res.render('admin/statements', { title: 'Выписки банка', uploads });
});

router.post('/statements', (req, res) => {
  stmtUpload.single('file')(req, res, (err) => {
    if (err || !req.file) {
      u.flash(req, 'error', err ? 'Файл слишком большой' : 'Выберите файл выписки');
      return res.redirect('/admin/statements');
    }
    try {
      const { upload, stats } = statement.importStatement(req.file.buffer, { filename: u.str(req.file.originalname, 200), userId: req.user.id });
      u.flash(req, 'ok', `Поступлений: ${stats.incoming}. Зачтено автоматически: ${stats.matched}, на проверку: ${stats.suggested + stats.unmatched}` +
        (stats.duplicates ? `, уже загружались раньше: ${stats.duplicates}` : ''));
      res.redirect(`/admin/statements/${upload}`);
    } catch (e) {
      u.flash(req, 'error', e.message);
      res.redirect('/admin/statements');
    }
  });
});

router.get('/statements/:sid', (req, res) => {
  const up = db.prepare('SELECT * FROM statement_uploads WHERE id = ?').get(Number(req.params.sid));
  if (!up) return res.redirect('/admin/statements');
  const rows = db.prepare(`SELECT t.*, a.number AS app_number, a.last_name, a.first_name, a.middle_name, e.name AS ip_name
    FROM bank_transactions t LEFT JOIN applications a ON a.id = t.application_id LEFT JOIN entrepreneurs e ON e.id = t.entrepreneur_id
    WHERE t.upload_id = ? ORDER BY CASE t.status WHEN 'suggested' THEN 0 WHEN 'unmatched' THEN 1 WHEN 'matched' THEN 2 ELSE 3 END, t.id`).all(up.id);
  res.render('admin/statement', { title: `Выписка ${up.filename}`, up, rows });
});

router.post('/transactions/:tid/apply', (req, res) => {
  const tx = db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(Number(req.params.tid));
  if (!tx) return res.redirect('/admin/statements');
  let appId = tx.application_id;
  if (req.body.contract) {
    const num = statement.contractNumber(req.body.contract) || u.str(req.body.contract, 30);
    const app = db.prepare("SELECT id FROM applications WHERE number = ? AND status IN ('signed','closed')").get(num);
    appId = app && app.id;
    if (!appId) {
      u.flash(req, 'error', `Оформленный договор ${num} не найден`);
      return res.redirect(`/admin/statements/${tx.upload_id}`);
    }
  }
  const ok = appId && statement.applyTransaction(tx.id, appId, req.user.id);
  u.flash(req, ok ? 'ok' : 'error', ok ? 'Поступление зачтено в график' : 'Не удалось зачесть поступление');
  res.redirect(`/admin/statements/${tx.upload_id}`);
});

router.post('/transactions/:tid/ignore', (req, res) => {
  const tx = db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(Number(req.params.tid));
  if (!tx) return res.redirect('/admin/statements');
  db.prepare("UPDATE bank_transactions SET status = 'ignored' WHERE id = ? AND status IN ('suggested','unmatched')").run(tx.id);
  res.redirect(`/admin/statements/${tx.upload_id}`);
});

// ---------- аннулирование ----------
router.get('/annulments', (req, res) => {
  const rows = db.prepare(`
    SELECT n.*, a.number, a.id AS app_id, a.status AS app_status, a.total_amount, a.product_name, a.contract_signed_at,
           a.last_name, a.first_name, a.middle_name, a.seller_commission,
           u.last_name AS s_last, u.first_name AS s_first, u.middle_name AS s_middle,
           (SELECT coalesce(sum(paid_amount), 0) FROM payments p WHERE p.application_id = a.id) + a.down_payment AS paid
    FROM annulments n JOIN applications a ON a.id = n.application_id LEFT JOIN users u ON u.id = n.requested_by
    ORDER BY CASE n.status WHEN 'pending' THEN 0 ELSE 1 END, n.id DESC LIMIT 200`).all();
  res.render('admin/annulments', { title: 'Аннулирование', rows, ANNUL_STATUS: annulments.ANNUL_STATUS });
});

router.post('/annulments/:nid/approve', (req, res) => {
  const r = annulments.approve(Number(req.params.nid), req.user.id, u.str(req.body.comment, 500));
  u.flash(req, r ? 'ok' : 'error', r ? 'Рассрочка аннулирована. Напоминания и претензии по ней остановлены, вознаграждение продавца сторнировано.' : 'Запрос уже обработан');
  res.redirect(req.body.back === 'list' || !r ? '/admin/annulments' : `/app/${r.application_id}`);
});

router.post('/annulments/:nid/reject', (req, res) => {
  const comment = u.str(req.body.comment, 500);
  const pending = db.prepare("SELECT * FROM annulments WHERE id = ? AND status = 'pending'").get(Number(req.params.nid));
  if (pending && !comment) {
    u.flash(req, 'error', 'Укажите причину отказа — её увидит продавец');
    return res.redirect(req.body.back === 'list' ? '/admin/annulments' : `/app/${pending.application_id}`);
  }
  const r = annulments.reject(Number(req.params.nid), req.user.id, comment);
  u.flash(req, r ? 'ok' : 'error', r ? 'В аннулировании отказано' : 'Запрос уже обработан');
  res.redirect(req.body.back === 'list' || !r ? '/admin/annulments' : `/app/${r.application_id}`);
});

// ---------- выплаты вознаграждения продавцам ----------
router.get('/payouts', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, u.last_name, u.first_name, u.middle_name, u.phone
    FROM payouts p JOIN users u ON u.id = p.seller_id
    ORDER BY CASE p.status WHEN 'requested' THEN 0 ELSE 1 END, p.id DESC LIMIT 200`).all()
    .map((p) => ({ ...p, bal: p.status === 'requested' ? commission.balance(p.seller_id) : null }));
  const sellers = db.prepare("SELECT id, last_name, first_name, middle_name FROM users WHERE role = 'seller' AND status IN ('approved','blocked') ORDER BY last_name").all()
    .map((s) => ({ ...s, bal: commission.balance(s.id) }))
    .filter((s) => s.bal.earned || s.bal.total);
  res.render('admin/payouts', { title: 'Выплаты продавцам', rows, sellers, PAYOUT_STATUS: commission.PAYOUT_STATUS });
});

router.post('/payouts/:pid/paid', (req, res) => {
  const p = commission.markPaid(Number(req.params.pid), req.user.id, u.str(req.body.comment, 300));
  u.flash(req, p ? 'ok' : 'error', p ? `Выплата ${u.moneyFmt(p.amount)} отмечена` : 'Заявка уже обработана');
  res.redirect('/admin/payouts');
});

router.post('/payouts/:pid/reject', (req, res) => {
  const comment = u.str(req.body.comment, 300);
  if (!comment) { u.flash(req, 'error', 'Укажите причину отказа'); return res.redirect('/admin/payouts'); }
  const ok = commission.rejectPayout(Number(req.params.pid), req.user.id, comment);
  u.flash(req, ok ? 'ok' : 'error', ok ? 'В выплате отказано' : 'Заявка уже обработана');
  res.redirect('/admin/payouts');
});

// ---------- аналитика ----------
router.get('/analytics', (req, res) => {
  const p = analytics.period(req.query);
  const prevP = analytics.previous(p);
  const cur = analytics.summary(p);
  const prev = analytics.summary(prevP);
  const ser = analytics.series(p);
  res.render('admin/analytics', {
    title: 'Аналитика', p, prevP, cur, prev, ser,
    portfolio: analytics.portfolio(),
    bySeller: analytics.bySeller(p), byIp: analytics.byIp(p), byTerm: analytics.byTerm(p),
    ticks: analytics.ticks, change: analytics.change, PRESETS: analytics.PRESETS,
  });
});

// ---------- претензии ----------
router.post('/claims/:cid/close', (req, res) => {
  const c = db.prepare("SELECT * FROM claims WHERE id = ? AND status <> 'closed'").get(Number(req.params.cid));
  if (c) {
    db.prepare("UPDATE claims SET status = 'closed', closed_at = datetime('now'), close_reason = ? WHERE id = ?")
      .run(u.str(req.body.reason, 300) || 'Закрыта администратором', c.id);
    u.flash(req, 'ok', 'Претензия закрыта');
  }
  res.redirect(req.body.back === 'list' ? '/app/claims' : `/app/${c ? c.application_id : ''}`);
});

router.post('/jobs/run', async (req, res) => {
  const r = await jobs.runAll({ manual: true });
  u.flash(req, r ? 'ok' : 'error', r ? `Проверка выполнена. Отправлено напоминаний: ${r.sent}, сформировано претензий: ${r.claims}` : 'Проверка уже выполняется, попробуйте через минуту');
  res.redirect('/admin/settings');
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
  publicUrl: (db.prepare("SELECT value FROM settings WHERE key = 'public_url'").get() || {}).value || process.env.PUBLIC_URL || '',
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
  const reminder = Number(req.body.reminder_days);
  const claimAfter = Number(req.body.claim_after_days);
  if (Number.isInteger(reminder) && reminder >= 1 && reminder <= 15) setSetting('reminder_days', reminder);
  if (Number.isInteger(claimAfter) && claimAfter >= 1 && claimAfter <= 60) setSetting('claim_after_days', claimAfter);
  // ставки вознаграждения продавца: поле rate_N — «срок от N мес»
  const rates = {};
  for (let m = 1; m <= 36; m++) {
    const raw = req.body[`rate_${m}`];
    if (raw === undefined || raw === '') continue;
    const v = Number(String(raw).replace(',', '.'));
    if (v >= 0 && v <= 50) rates[m] = v;
  }
  if (Object.keys(rates).length) setSetting('commission_rates', JSON.stringify(rates));
  if (['total', 'price'].includes(req.body.commission_base)) setSetting('commission_base', req.body.commission_base);
  const url = u.str(req.body.public_url, 200).replace(/\/$/, '');
  if (!url || /^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(url)) setSetting('public_url', url);
  u.flash(req, 'ok', 'Настройки сохранены');
  res.redirect('/admin/settings');
});

router.post('/settings/phone', (req, res) => {
  const newPhone = u.normPhone(req.body.phone);
  if (!bcrypt.compareSync(String(req.body.current || ''), req.user.password_hash)) u.flash(req, 'error', 'Текущий пароль неверен');
  else if (!u.isPhone(newPhone)) u.flash(req, 'error', 'Введите номер в формате +7 (XXX) XXX-XX-XX');
  else if (newPhone === req.user.phone) u.flash(req, 'error', 'Это ваш текущий номер');
  else if (db.prepare('SELECT 1 FROM users WHERE phone = ? AND id <> ?').get(newPhone, req.user.id)) u.flash(req, 'error', 'Этот номер уже занят продавцом');
  else {
    db.prepare("UPDATE users SET phone = ?, updated_at = datetime('now') WHERE id = ?").run(newPhone, req.user.id);
    u.flash(req, 'ok', `Телефон изменён. Теперь входите с номером ${u.phoneFmt(newPhone)}`);
  }
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
