const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// встроенный lower() в SQLite не понимает кириллицу
db.function('lower_ru', { deterministic: true }, (s) => (s == null ? null : String(s).toLowerCase().replace(/ё/g, 'е')));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('admin','seller')),
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  last_name TEXT, first_name TEXT, middle_name TEXT,
  birth_date TEXT, email TEXT,
  passport_series TEXT, passport_number TEXT, passport_issued_by TEXT,
  passport_issue_date TEXT, passport_dept_code TEXT,
  reg_address TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','correction','blocked')),
  admin_comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ИП (индивидуальные предприниматели) с реквизитами
CREATE TABLE IF NOT EXISTS entrepreneurs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,            -- краткое: ИП Иванов И. И.
  full_name TEXT NOT NULL,       -- полное: Индивидуальный предприниматель Иванов Иван Иванович
  inn TEXT NOT NULL,
  ogrnip TEXT NOT NULL,
  address TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  bik TEXT NOT NULL,
  account TEXT NOT NULL,         -- расчётный счёт
  corr_account TEXT NOT NULL,    -- корр. счёт
  phone TEXT, email TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_entrepreneurs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entrepreneur_id INTEGER NOT NULL REFERENCES entrepreneurs(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, entrepreneur_id)
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT UNIQUE,
  seller_id INTEGER NOT NULL REFERENCES users(id),
  entrepreneur_id INTEGER NOT NULL REFERENCES entrepreneurs(id),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','approved','declined','signed','cancelled','closed')),

  -- товар и условия (суммы в копейках)
  product_name TEXT NOT NULL,
  product_price INTEGER NOT NULL,
  down_payment INTEGER NOT NULL DEFAULT 0,
  months INTEGER NOT NULL,
  markup_percent REAL NOT NULL,
  markup_amount INTEGER NOT NULL,
  total_amount INTEGER NOT NULL,
  financed_amount INTEGER NOT NULL,
  monthly_payment INTEGER NOT NULL,

  -- анкета клиента
  client_filled_at TEXT,
  last_name TEXT, first_name TEXT, middle_name TEXT,
  gender TEXT, birth_date TEXT, birth_place TEXT,
  phone TEXT, email TEXT,
  passport_series TEXT, passport_number TEXT, passport_issued_by TEXT,
  passport_issue_date TEXT, passport_dept_code TEXT,
  reg_address TEXT, fact_address TEXT,
  marital_status TEXT, dependents INTEGER,
  employment_type TEXT, work_place TEXT, work_position TEXT, work_address TEXT,
  work_phone TEXT, work_experience TEXT, monthly_income INTEGER,
  contact_name TEXT, contact_phone TEXT, contact_relation TEXT,

  -- SMS-подтверждение телефона и согласие на обработку ПД
  phone_verified_at TEXT,
  pd_consent_signed_at TEXT,
  pd_consent_ip TEXT,

  -- проверка по базам
  check_status TEXT CHECK (check_status IN ('clean','hit','override')),
  check_result TEXT,
  checked_at TEXT,

  -- договор
  contract_signed_at TEXT,
  contract_sign_ip TEXT,
  first_payment_date TEXT,

  admin_comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_app_seller ON applications(seller_id);
CREATE INDEX IF NOT EXISTS idx_app_client ON applications(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_app_passport ON applications(passport_series, passport_number);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS sms_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  purpose TEXT NOT NULL,
  application_id INTEGER,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

-- внутренний стоп-лист (недобросовестные клиенты)
CREATE TABLE IF NOT EXISTS blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  last_name TEXT, first_name TEXT, middle_name TEXT, birth_date TEXT,
  passport_series TEXT, passport_number TEXT,
  phone TEXT,
  reason TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- фото документов клиента (паспорт, прописка, фото клиента)
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('passport_main','passport_reg','client_photo')),
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_app ON documents(application_id);

-- сеанс загрузки фото с телефона по QR-коду
CREATE TABLE IF NOT EXISTS scan_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','processing','done','error')),
  result TEXT,
  error TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`);

const DEFAULT_SETTINGS = {
  markup_percent: '3',
  min_months: '1',
  max_months: '6',
  support_phone: '',
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

function getSettings() {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return {
    markupPercent: Number(out.markup_percent),
    minMonths: Number(out.min_months),
    maxMonths: Number(out.max_months),
    supportPhone: out.support_phone,
  };
}

// Ключи внешних сервисов: переменная окружения имеет приоритет над значением из админки
const SECRET_ENV = {
  sms_ru_api_id: 'SMS_RU_API_ID',
  sms_from: 'SMS_FROM',
  yandex_api_key: 'YANDEX_VISION_API_KEY',
  yandex_folder_id: 'YANDEX_FOLDER_ID',
};
function getSecret(key) {
  const env = SECRET_ENV[key] && process.env[SECRET_ENV[key]];
  if (env) return env;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : '';
}
const secretFromEnv = (key) => Boolean(SECRET_ENV[key] && process.env[SECRET_ENV[key]]);

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// Секрет сессий хранится рядом с базой, чтобы переживать перезапуски
function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, 'session.secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

// Первый администратор создаётся при первом запуске
function ensureAdmin() {
  const exists = db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get();
  if (exists) return;
  const phone = (process.env.ADMIN_PHONE || '79990000000').replace(/\D/g, '');
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  db.prepare(`INSERT INTO users (role, phone, password_hash, last_name, first_name, status)
              VALUES ('admin', ?, ?, 'Администратор', '', 'approved')`)
    .run(phone, bcrypt.hashSync(password, 10));
  console.log('\n=== Создан администратор ===');
  console.log(`Телефон: +${phone}`);
  if (!process.env.ADMIN_PASSWORD) console.log(`Пароль:  ${password}  (смените после входа)`);
  console.log('============================\n');
}

module.exports = { db, DATA_DIR, getSettings, setSetting, getSecret, secretFromEnv, getSessionSecret, ensureAdmin };
