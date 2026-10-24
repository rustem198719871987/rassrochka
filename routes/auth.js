const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../lib/db');
const u = require('../lib/util');

const router = express.Router();

const activeIps = () => db.prepare('SELECT * FROM entrepreneurs WHERE active = 1 ORDER BY name').all();
const userIpIds = (userId) =>
  db.prepare('SELECT entrepreneur_id FROM user_entrepreneurs WHERE user_id = ?').all(userId).map((r) => r.entrepreneur_id);

function home(user) {
  if (!user) return '/login';
  if (user.role === 'admin') return '/admin';
  return user.status === 'approved' ? '/app/new' : '/status';
}

router.get('/', (req, res) => res.redirect(home(req.user)));

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(home(req.user));
  res.render('auth/login', { title: 'Вход в личный кабинет', tab: 'login' });
});

const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

router.post('/login', (req, res, next) => {
  const phone = u.normPhone(req.body.phone);
  const render = (error) => res.status(400).render('auth/login', { title: 'Вход', tab: 'login', error, form: { phone: req.body.phone } });

  // перебор пароля: 10 попыток за 10 минут с одного адреса и 20 в час на один номер (с любых адресов)
  if (!u.rateLimit(`login:${req.ip}`, 10, 10 * 60e3) || !u.rateLimit(`login-phone:${phone}`, 20, 3600e3)) {
    return render('Слишком много попыток. Подождите и попробуйте позже.');
  }
  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  // пароль проверяется и для несуществующего номера — по времени ответа нельзя узнать, зарегистрирован ли номер
  const passOk = bcrypt.compareSync(String(req.body.password || '').slice(0, 200), user ? user.password_hash : DUMMY_HASH);
  if (!user || !passOk) return render('Неверный номер телефона или пароль');
  if (user.status === 'blocked') return render('Учётная запись заблокирована. Обратитесь к администратору.');

  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    res.redirect(home(user));
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- регистрация продавца ----------
function readRegistration(body, { requirePassword }) {
  const errors = {};
  const person = u.readPerson(body, errors);
  const data = {
    ...person,
    phone: u.normPhone(body.phone),
    email: u.str(body.email, 120),
  };
  if (!u.isPhone(data.phone)) errors.phone = 'Введите номер в формате +7 (XXX) XXX-XX-XX';
  if (data.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) errors.email = 'Неверный e-mail';

  const ipIds = [].concat(body.ip_ids || []).map(Number).filter(Boolean);
  const valid = new Set(activeIps().map((i) => i.id));
  data.ipIds = ipIds.filter((id) => valid.has(id));
  if (valid.size && !data.ipIds.length) errors.ip_ids = 'Выберите хотя бы одного ИП';

  if (requirePassword) {
    const pass = String(body.password || '');
    if (pass.length < 8) errors.password = 'Минимум 8 символов';
    else if (pass.length > 200) errors.password = 'Слишком длинный пароль';
    else if (pass !== body.password2) errors.password2 = 'Пароли не совпадают';
    data.password = pass;
    if (!body.agree) errors.agree = 'Необходимо согласие на обработку персональных данных';
  }
  return { data, errors };
}

const PERSON_COLS = ['last_name', 'first_name', 'middle_name', 'birth_date', 'email', 'passport_series', 'passport_number',
  'passport_issued_by', 'passport_issue_date', 'passport_dept_code', 'reg_address'];

const setUserIps = db.transaction((userId, ipIds) => {
  db.prepare('DELETE FROM user_entrepreneurs WHERE user_id = ?').run(userId);
  const ins = db.prepare('INSERT INTO user_entrepreneurs (user_id, entrepreneur_id) VALUES (?, ?)');
  for (const id of ipIds) ins.run(userId, id);
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect(home(req.user));
  res.render('auth/register', { title: 'Регистрация продавца', tab: 'register', ips: activeIps(), form: { ip_ids: [] } });
});

router.post('/register', (req, res, next) => {
  if (!u.rateLimit(`register:${req.ip}`, 5, 3600e3)) {
    return res.status(429).render('auth/register', { title: 'Регистрация продавца', tab: 'register', ips: activeIps(), form: { ...req.body, ip_ids: [] },
      errors: {}, error: 'Слишком много регистраций с этого адреса. Попробуйте через час.' });
  }
  const { data, errors } = readRegistration(req.body, { requirePassword: true });
  if (!errors.phone && db.prepare('SELECT 1 FROM users WHERE phone = ?').get(data.phone)) {
    errors.phone = 'Этот номер уже зарегистрирован';
  }
  if (Object.keys(errors).length) {
    return res.status(400).render('auth/register', {
      title: 'Регистрация продавца', tab: 'register', ips: activeIps(), errors,
      form: { ...req.body, ip_ids: data.ipIds },
    });
  }

  const id = db.transaction(() => {
    const info = db.prepare(`INSERT INTO users (role, phone, password_hash, ${PERSON_COLS.join(', ')}, status)
      VALUES ('seller', ?, ?, ${PERSON_COLS.map(() => '?').join(', ')}, 'pending')`)
      .run(data.phone, bcrypt.hashSync(data.password, 10), ...PERSON_COLS.map((c) => data[c]));
    setUserIps(info.lastInsertRowid, data.ipIds);
    return info.lastInsertRowid;
  })();

  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = id;
    u.flash(req, 'ok', 'Заявка на регистрацию отправлена администратору');
    res.redirect('/status');
  });
});

// ---------- статус заявки продавца / корректировка ----------
router.get('/status', (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (req.user.role === 'admin' || req.user.status === 'approved') return res.redirect(home(req.user));
  res.render('auth/status', {
    title: 'Статус регистрации', ips: activeIps(),
    form: { ...req.user, ip_ids: userIpIds(req.user.id) },
  });
});

router.post('/status', (req, res) => {
  if (!req.user || req.user.role !== 'seller' || req.user.status !== 'correction') return res.redirect('/status');
  const { data, errors } = readRegistration({ ...req.body, phone: req.user.phone }, { requirePassword: false });
  if (Object.keys(errors).length) {
    return res.status(400).render('auth/status', {
      title: 'Статус регистрации', ips: activeIps(), errors, form: { ...req.body, ip_ids: data.ipIds },
    });
  }
  db.transaction(() => {
    db.prepare(`UPDATE users SET ${PERSON_COLS.map((c) => `${c} = ?`).join(', ')}, status = 'pending', updated_at = datetime('now')
                WHERE id = ?`).run(...PERSON_COLS.map((c) => data[c]), req.user.id);
    setUserIps(req.user.id, data.ipIds);
  })();
  u.flash(req, 'ok', 'Данные исправлены и повторно отправлены на проверку');
  res.redirect('/status');
});

module.exports = router;
module.exports.setUserIps = setUserIps;
module.exports.PERSON_COLS = PERSON_COLS;
