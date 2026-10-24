// Выписки, которые банк сам присылает на почту сайта (например, rustem@rassrochka.top).
//
// Почтовый сервер Postfix на этом же сервере (deploy/mail.sh) кладёт письма в DATA_DIR/mail/inbox/new.
// Каждые 2 минуты сайт разбирает новые письма и удаляет их:
//  1. отправитель должен быть в списке разрешённых (Настройки → Почта для выписок);
//  2. подпись банка должна подтвердиться (DMARC, либо DKIM или SPF домена отправителя) —
//     иначе любой мог бы прислать «выписку» с поддельными оплатами;
//  3. вложение в формате 1С (1CClientBankExchange) проходит ту же сверку, что и ручная загрузка.
// Результат каждого письма — в журнале inbound_mail (видно администратору в Настройках).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { simpleParser } = require('mailparser');
const { authenticate } = require('mailauth');
const { db, DATA_DIR, getSecret } = require('./db');
const statement = require('./statement');

const MAIL_DIR = path.join(DATA_DIR, 'mail');
const INBOX = path.join(MAIL_DIR, 'inbox', 'new');
const MAX_SIZE = 25 * 1024 * 1024;

// Адрес записывает deploy/mail.sh, когда почтовый сервер настроен
function address() {
  try { return fs.readFileSync(path.join(MAIL_DIR, '.address'), 'utf8').trim(); } catch (e) { return ''; }
}

const allowedSenders = () => String(getSecret('mail_senders') || '').toLowerCase().split(/[\s,;]+/).filter((s) => /@/.test(s));
const senderAllowed = (addr, list) => list.some((s) => (s.startsWith('@') ? addr.endsWith(s) : addr === s));

// Конверт письма из верхнего заголовка Received — его добавил наш Postfix, подделать его отправитель не может
function envelope(raw) {
  const head = raw.subarray(0, Math.min(raw.length, 64 * 1024)).toString('latin1').split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  const lines = head.split(/\r?\n/);
  const received = lines.find((l) => /^received:/i.test(l)) || '';
  const returnPath = lines.find((l) => /^return-path:/i.test(l)) || '';
  return {
    ip: (received.match(/\[(?:IPv6:)?([0-9a-f.:]+)\]/i) || [])[1],
    helo: (received.match(/^received:\s*from\s+(\S+)/i) || [])[1],
    sender: (returnPath.match(/<([^>]*)>/) || [])[1] || '',
  };
}

// Домены совпадают с точностью до поддомена (bank.ru и mail.bank.ru)
const aligned = (a, b) => Boolean(a && b) && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));

function authentic(auth, fromAddr, env) {
  const fromDomain = fromAddr.split('@')[1] || '';
  if (auth.dmarc && auth.dmarc.status && auth.dmarc.status.result === 'pass') return true;
  const dkim = ((auth.dkim && auth.dkim.results) || []).some((r) => r.status && r.status.result === 'pass' && aligned(String(r.signingDomain || '').toLowerCase(), fromDomain));
  const spf = auth.spf && auth.spf.status && auth.spf.status.result === 'pass' && aligned(String(env.sender.split('@')[1] || '').toLowerCase(), fromDomain);
  return dkim || spf;
}

const is1C = (buf) => buf.subarray(0, 200).toString('latin1').replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart().startsWith('1CClientBankExchange');

const log = (row) => db.prepare('INSERT INTO inbound_mail (mail_from, subject, status, reason, upload_id, stats) VALUES (?, ?, ?, ?, ?, ?)')
  .run(row.from || null, row.subject || null, row.status, row.reason || null, row.upload || null, row.stats ? JSON.stringify(row.stats) : null);

async function processFile(file, { resolver } = {}) {
  const raw = fs.readFileSync(file);
  if (raw.length > MAX_SIZE) return log({ status: 'rejected', reason: 'Письмо больше 25 МБ' });
  const mail = await simpleParser(raw);
  const from = String((mail.from && mail.from.value && mail.from.value[0] && mail.from.value[0].address) || '').toLowerCase();
  const base = { from, subject: String(mail.subject || '').slice(0, 300) };

  const senders = allowedSenders();
  if (!senders.length) return log({ ...base, status: 'rejected', reason: 'Не указаны разрешённые отправители (Настройки → Почта для выписок)' });
  if (!from || !senderAllowed(from, senders)) {
    // письма посторонних (в том числе спам) не засоряют журнал — только счётчик
    db.prepare("INSERT INTO settings (key, value) VALUES ('mail_spam_count', '1') ON CONFLICT(key) DO UPDATE SET value = value + 1").run();
    // последние 5 посторонних отправителей — чтобы по первому письму банка узнать его адрес и разрешить его
    const recentSpam = [{ from, subject: base.subject.slice(0, 80), at: new Date().toISOString() }, ...spamRecent().filter((r) => r.from !== from)].slice(0, 5);
    db.prepare("INSERT INTO settings (key, value) VALUES ('mail_spam_recent', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(recentSpam));
    return null;
  }

  const env = envelope(raw);
  const auth = await authenticate(raw, { ip: env.ip, helo: env.helo, sender: env.sender, mta: os.hostname(), resolver });
  if (!authentic(auth, from, env)) {
    return log({ ...base, status: 'rejected', reason: 'Подпись отправителя не подтверждена (DKIM/SPF) — письмо могло быть подделано' });
  }

  const files = (mail.attachments || []).filter((a) => a.content && is1C(a.content));
  if (!files.length) {
    const names = (mail.attachments || []).map((a) => a.filename || a.contentType).join(', ');
    return log({ ...base, status: 'no_statement', reason: names ? `Во вложениях нет выписки 1С: ${names}` : 'В письме нет вложений' });
  }
  for (const a of files) {
    try {
      const { upload, stats } = statement.importStatement(a.content, { filename: `Почта ${from}: ${a.filename || 'выписка.txt'}`.slice(0, 200), userId: null });
      log({ ...base, status: 'imported', reason: a.filename, upload, stats });
    } catch (e) {
      log({ ...base, status: 'error', reason: `${a.filename}: ${e.message}` });
    }
  }
  return null;
}

let running = false;
async function processInbox(opts = {}) {
  if (running || !fs.existsSync(INBOX)) return { processed: 0 };
  running = true;
  let processed = 0;
  try {
    for (const name of fs.readdirSync(INBOX)) {
      const file = path.join(INBOX, name);
      try {
        await processFile(file, opts);
      } catch (e) {
        console.error('[почта] письмо не разобрано:', e.message);
        log({ status: 'error', reason: `Письмо не разобрано: ${e.message}`.slice(0, 300) });
      }
      // письмо удаляется в любом случае: выписка уже в базе, а повторный разбор сбойного письма ничего не даст
      fs.rmSync(file, { force: true });
      processed++;
    }
    db.prepare("DELETE FROM inbound_mail WHERE received_at < datetime('now', '-180 days')").run();
  } finally {
    running = false;
  }
  if (processed) console.log(`[почта] обработано писем: ${processed}`);
  return { processed };
}

function start() {
  setTimeout(() => processInbox().catch((e) => console.error('[почта]', e)), 10e3);
  setInterval(() => processInbox().catch((e) => console.error('[почта]', e)), 2 * 60e3);
}

const recent = (limit = 20) => db.prepare('SELECT * FROM inbound_mail ORDER BY id DESC LIMIT ?').all(limit);

function spamRecent() {
  try { return JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'mail_spam_recent'").get() || {}).value || '[]'); } catch (e) { return []; }
}
const spamCount = () => Number((db.prepare("SELECT value FROM settings WHERE key = 'mail_spam_count'").get() || {}).value || 0);

module.exports = { spamCount, spamRecent, processInbox, processFile, start, address, recent, allowedSenders, envelope, authentic, MAIL_DIR, INBOX };
