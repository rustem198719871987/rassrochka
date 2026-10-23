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

// ---------- миграции: номер версии схемы хранится в PRAGMA user_version ----------
const MIGRATIONS = [
  // 1: сканы договора, учёт оплат, выписки, SMS-журнал, претензии
  () => db.exec(`
    CREATE TABLE documents_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('passport_main','passport_reg','client_photo','contract_page')),
      page INTEGER,
      file TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      uploaded_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO documents_new (id, application_id, kind, file, mime, size, created_at)
      SELECT id, application_id, kind, file, mime, size, created_at FROM documents;
    DROP TABLE documents;
    ALTER TABLE documents_new RENAME TO documents;
    CREATE INDEX idx_documents_app ON documents(application_id);

    ALTER TABLE scan_sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'passport';

    ALTER TABLE payments ADD COLUMN paid_amount INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE payments ADD COLUMN reminded_at TEXT;
    CREATE INDEX idx_payments_app ON payments(application_id);
    CREATE INDEX idx_payments_due ON payments(due_date);

    -- ссылка для клиента на страницу оплаты
    ALTER TABLE applications ADD COLUMN pay_token TEXT;
    UPDATE applications SET pay_token = lower(hex(randomblob(18)));
    CREATE UNIQUE INDEX idx_app_pay_token ON applications(pay_token);
    -- неустойка фиксируется в договоре на дату оформления
    ALTER TABLE applications ADD COLUMN penalty_percent REAL NOT NULL DEFAULT 0.1;

    -- поступления денег по договору; график закрывается только подтверждёнными
    CREATE TABLE payment_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL CHECK (amount > 0),
      paid_on TEXT NOT NULL,
      method TEXT NOT NULL CHECK (method IN ('bank','cash','card','other')),
      status TEXT NOT NULL CHECK (status IN ('pending','confirmed','rejected','cancelled')),
      bank_tx_id INTEGER,
      comment TEXT,
      created_by INTEGER REFERENCES users(id),
      decided_by INTEGER REFERENCES users(id),
      decided_at TEXT,
      decision_comment TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_records_app ON payment_records(application_id);
    CREATE INDEX idx_records_status ON payment_records(status);
    -- оплаты, отмеченные до появления журнала, переносим в журнал
    INSERT INTO payment_records (application_id, amount, paid_on, method, status, comment)
      SELECT application_id, amount, substr(paid_at, 1, 10), 'other', 'confirmed', 'Отмечено до обновления системы'
      FROM payments WHERE paid_at IS NOT NULL;
    UPDATE payments SET paid_amount = amount WHERE paid_at IS NOT NULL;

    CREATE TABLE statement_uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      uploaded_by INTEGER REFERENCES users(id),
      total INTEGER NOT NULL DEFAULT 0,
      matched INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE bank_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upload_id INTEGER NOT NULL REFERENCES statement_uploads(id),
      hash TEXT NOT NULL UNIQUE,
      doc_number TEXT, doc_date TEXT, amount INTEGER NOT NULL,
      payer_name TEXT, payer_inn TEXT, payer_account TEXT,
      recipient_account TEXT, purpose TEXT,
      entrepreneur_id INTEGER REFERENCES entrepreneurs(id),
      application_id INTEGER REFERENCES applications(id),
      status TEXT NOT NULL CHECK (status IN ('matched','suggested','unmatched','ignored')),
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_tx_upload ON bank_transactions(upload_id);

    -- журнал SMS клиентам
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
      payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      phone TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sent','test','error')),
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_notifications_app ON notifications(application_id);

    -- претензии по просрочке
    CREATE TABLE claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      number TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','handed','delivered','closed')),
      overdue_amount INTEGER NOT NULL,
      penalty INTEGER NOT NULL,
      overdue_days INTEGER NOT NULL,
      details TEXT NOT NULL,
      handed_at TEXT, handed_by INTEGER REFERENCES users(id),
      delivered_at TEXT, delivered_by INTEGER REFERENCES users(id),
      closed_at TEXT, close_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_claims_app ON claims(application_id);
  `),
];

db.transaction(() => {
  const version = db.pragma('user_version', { simple: true });
  MIGRATIONS.slice(version).forEach((m, i) => {
    m();
    db.pragma(`user_version = ${version + i + 1}`);
  });
})();

const DEFAULT_SETTINGS = {
  markup_percent: '3',
  min_months: '1',
  max_months: '6',
  support_phone: '',
  reminder_days: '5',
  claim_after_days: '5',
  penalty_percent: '0.1',
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
    reminderDays: Number(out.reminder_days),
    claimAfterDays: Number(out.claim_after_days),
    penaltyPercent: Number(out.penalty_percent),
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
