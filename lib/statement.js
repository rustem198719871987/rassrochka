// Банковская выписка в формате обмена с 1С (1CClientBankExchange) — его выгружает любой банк:
// «Выписка» → «Экспорт» / «Выгрузить в 1С». Кодировка Windows-1251, DOS (866) или UTF-8.
const crypto = require('crypto');
const { db } = require('./db');
const payments = require('./payments');

function decode(buf) {
  const utf = buf.toString('utf8');
  if (utf.includes('1CClientBankExchange') && !utf.includes('�')) return utf.replace(/^﻿/, '');
  const win = new TextDecoder('windows-1251').decode(buf);
  if (/Кодировка\s*=\s*DOS/i.test(win)) return new TextDecoder('ibm866').decode(buf);
  return win;
}

function parse(buf) {
  const text = decode(buf);
  if (!text.includes('1CClientBankExchange')) throw new Error('Это не выписка в формате 1С. В интернет-банке выберите «Экспорт в 1С» (файл .txt).');
  const docs = [];
  const accounts = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('СекцияДокумент')) { cur = { _type: line.split('=')[1] || '' }; continue; }
    if (line === 'КонецДокумента') { if (cur) docs.push(cur); cur = null; continue; }
    const i = line.indexOf('=');
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (cur) cur[k] = v;
    else if (k === 'РасчСчет') accounts.push(v);
  }
  return { accounts, docs: docs.map(normalize) };
}

const ruDate = (s) => {
  const m = String(s || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

function normalize(d) {
  const amount = Math.round(Number(String(d['Сумма'] || '0').replace(/\s/g, '').replace(',', '.')) * 100);
  return {
    doc_number: d['Номер'] || '',
    doc_date: ruDate(d['ДатаПоступило']) || ruDate(d['Дата']),
    amount,
    payer_name: d['Плательщик1'] || (d['Плательщик'] || '').replace(/^ИНН\s*\d*\s*/i, ''),
    payer_inn: d['ПлательщикИНН'] || '',
    payer_account: d['ПлательщикСчет'] || d['ПлательщикРасчСчет'] || '',
    recipient_account: d['ПолучательСчет'] || d['ПолучательРасчСчет'] || '',
    recipient_inn: d['ПолучательИНН'] || '',
    purpose: d['НазначениеПлатежа'] || '',
  };
}

// Номер договора в назначении платежа: «РТ-26-000012», «РТ 26 000012», «RT-26-12».
// «РТ» — отдельным словом (не хвост слова вроде TRANSPORT), номер — не часть более длинного числа.
function contractNumber(purpose) {
  const m = String(purpose || '').match(/(?<![A-Za-zА-Яа-яЁё0-9])(?:РТ|RT|PT)[\s-]*(\d{2})[\s-]*(\d{1,6})(?!\d)/i);
  return m ? `РТ-${m[1]}-${m[2].padStart(6, '0')}` : null;
}

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

// Перечисление от Сбербанка (ИНН 7707083893) по операциям эквайринга / СБП
const isAcquiringSettlement = (d) => d.payer_inn === '7707083893' && /эквайринг|возмещ|по операциям|сбп|qr/i.test(d.purpose);

// Сопоставляет поступления с договорами; подтверждённые сразу зачитываются в график
function importStatement(buf, { filename, userId }) {
  const { docs } = parse(buf);
  const ips = db.prepare('SELECT * FROM entrepreneurs').all();
  const byAccount = new Map(ips.map((i) => [i.account, i]));
  const byInn = new Map(ips.map((i) => [i.inn, i]));

  const upload = db.prepare('INSERT INTO statement_uploads (filename, uploaded_by) VALUES (?, ?)').run(filename, userId).lastInsertRowid;
  const stats = { total: docs.length, incoming: 0, matched: 0, suggested: 0, unmatched: 0, ignored: 0, duplicates: 0, skipped: 0 };

  for (const d of docs) {
    const ip = byAccount.get(d.recipient_account) || (d.recipient_inn && byInn.get(d.recipient_inn));
    // исходящие платежи и поступления на чужие счета пропускаем
    if (!ip || byAccount.has(d.payer_account) || d.amount <= 0) { stats.skipped++; continue; }
    stats.incoming++;
    const hash = crypto.createHash('sha256')
      .update([d.doc_number, d.doc_date, d.amount, d.payer_account, d.recipient_account, d.purpose].join('|')).digest('hex');
    if (db.prepare('SELECT 1 FROM bank_transactions WHERE hash = ?').get(hash)) { stats.duplicates++; continue; }

    let status = 'unmatched';
    let app = null;
    let note = null;
    const num = contractNumber(d.purpose);
    if (isAcquiringSettlement(d)) {
      // Сбербанк перечисляет общей суммой деньги от онлайн-оплат — каждая из них уже зачтена в момент оплаты
      status = 'ignored';
      note = 'Зачисление по эквайрингу Сбербанка: онлайн-оплаты клиентов уже учтены';
    } else if (num) {
      app = db.prepare("SELECT * FROM applications WHERE number = ? AND status IN ('signed','closed')").get(num);
      if (app && app.entrepreneur_id === ip.id) { status = 'matched'; note = `Номер договора ${num} в назначении платежа`; }
      else if (app) { status = 'suggested'; note = `Договор ${num} оформлен на другого ИП — проверьте`; }
      else note = `Договор ${num} не найден среди оформленных`;
    }
    if (!app && status !== 'ignored') {
      const payer = norm(d.payer_name);
      const cands = db.prepare("SELECT * FROM applications WHERE status = 'signed' AND entrepreneur_id = ?").all(ip.id)
        .filter((a) => payer.includes(norm(a.last_name)) && payer.includes(norm(a.first_name)));
      if (cands.length === 1) { app = cands[0]; status = 'suggested'; note = 'Совпадает ФИО плательщика — проверьте и зачтите'; }
      else if (cands.length > 1) note = 'По ФИО плательщика подходит несколько договоров';
    }

    db.transaction(() => {
      const tx = db.prepare(`INSERT INTO bank_transactions (upload_id, hash, doc_number, doc_date, amount, payer_name, payer_inn, payer_account,
          recipient_account, purpose, entrepreneur_id, application_id, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(upload, hash, d.doc_number, d.doc_date, d.amount, d.payer_name, d.payer_inn, d.payer_account, d.recipient_account, d.purpose,
          ip.id, app ? app.id : null, status, note).lastInsertRowid;
      if (status === 'matched') {
        payments.addRecord({ applicationId: app.id, amount: d.amount, paidOn: d.doc_date || payments.today(), method: 'bank', status: 'confirmed',
          comment: `Выписка: п/п № ${d.doc_number}`, userId, bankTxId: tx });
      }
    })();
    stats[status]++;
  }
  db.prepare('UPDATE statement_uploads SET total = ?, matched = ? WHERE id = ?').run(stats.incoming, stats.matched, upload);
  return { upload, stats };
}

// Ручной зачёт поступления администратором
function applyTransaction(txId, applicationId, userId) {
  const tx = db.prepare("SELECT * FROM bank_transactions WHERE id = ? AND status IN ('suggested','unmatched')").get(txId);
  const app = db.prepare("SELECT * FROM applications WHERE id = ? AND status IN ('signed','closed')").get(applicationId);
  if (!tx || !app) return false;
  db.transaction(() => {
    db.prepare("UPDATE bank_transactions SET status = 'matched', application_id = ?, note = coalesce(note, '') || ' · зачтено вручную' WHERE id = ?").run(app.id, tx.id);
    payments.addRecord({ applicationId: app.id, amount: tx.amount, paidOn: tx.doc_date || payments.today(), method: 'bank', status: 'confirmed',
      comment: `Выписка: п/п № ${tx.doc_number}`, userId, bankTxId: tx.id });
  })();
  return true;
}

module.exports = { parse, importStatement, applyTransaction, contractNumber };
