const crypto = require('crypto');
const { db, getSessionSecret, getSecret } = require('./db');

const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

// Ключ SMS.ru задаётся в админке (Настройки) или в .env.
// Без ключа работаем в тестовом режиме: код пишется в консоль и показывается продавцу.
const isDevMode = () => !getSecret('sms_ru_api_id');

async function smsRu(method, params) {
  const url = new URL(`https://sms.ru/${method}`);
  url.searchParams.set('api_id', getSecret('sms_ru_api_id'));
  url.searchParams.set('json', '1');
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new Error('нет связи с sms.ru — проверьте интернет на сервере');
  }
  return { res, data: await res.json().catch(() => null) };
}

async function sendSms(phone, text) {
  if (isDevMode()) {
    console.log(`[SMS тест] +${phone}: ${text}`);
    return;
  }
  const { res, data } = await smsRu('sms/send', { to: phone, msg: text, from: getSecret('sms_from') });
  const item = data && data.sms && data.sms[phone];
  if (!data || data.status !== 'OK' || !item || item.status !== 'OK') {
    const reason = (item && item.status_text) || (data && data.status_text) || `HTTP ${res.status}`;
    throw new Error(`SMS не отправлено: ${reason}`);
  }
}

function hashCode(code) {
  return crypto.createHmac('sha256', getSessionSecret()).update(code).digest('hex');
}

// Создаёт и отправляет код. Возвращает код только в тестовом режиме.
async function sendCode({ phone, purpose, applicationId, text }) {
  const now = Date.now();
  const last = db.prepare(`SELECT created_at FROM sms_codes WHERE phone = ? AND purpose = ? AND application_id IS ?
                           ORDER BY id DESC LIMIT 1`).get(phone, purpose, applicationId ?? null);
  if (last && now - last.created_at < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - last.created_at)) / 1000);
    throw new Error(`Повторная отправка возможна через ${wait} сек.`);
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await sendSms(phone, text.replace('{code}', code));
  db.prepare(`INSERT INTO sms_codes (phone, purpose, application_id, code_hash, expires_at, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(phone, purpose, applicationId ?? null, hashCode(code), now + CODE_TTL_MS, now);
  return isDevMode() ? code : null;
}

function verifyCode({ phone, purpose, applicationId, code }) {
  const row = db.prepare(`SELECT * FROM sms_codes WHERE phone = ? AND purpose = ? AND application_id IS ? AND used_at IS NULL
                          ORDER BY id DESC LIMIT 1`).get(phone, purpose, applicationId ?? null);
  if (!row) return { ok: false, error: 'Сначала отправьте код' };
  if (row.expires_at < Date.now()) return { ok: false, error: 'Срок действия кода истёк, отправьте новый' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'Превышено число попыток, отправьте новый код' };

  const given = hashCode(String(code || '').replace(/\D/g, ''));
  const match = crypto.timingSafeEqual(Buffer.from(given), Buffer.from(row.code_hash));
  if (!match) {
    db.prepare('UPDATE sms_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return { ok: false, error: `Неверный код. Осталось попыток: ${MAX_ATTEMPTS - row.attempts - 1}` };
  }
  db.prepare('UPDATE sms_codes SET used_at = ? WHERE id = ?').run(Date.now(), row.id);
  return { ok: true };
}

async function balance() {
  if (isDevMode()) throw new Error('Ключ SMS.ru не указан');
  const { res, data } = await smsRu('my/balance', {});
  if (!data || data.status !== 'OK') throw new Error((data && data.status_text) || `HTTP ${res.status}`);
  return Number(data.balance);
}

// Информационное SMS: ошибка отправки не должна ломать оформление
async function notify(phone, text) {
  try { await sendSms(phone, text); } catch (e) { console.error('SMS-уведомление не отправлено:', e.message); }
}

module.exports = { sendCode, verifyCode, isDevMode, sendSms, balance, notify };
