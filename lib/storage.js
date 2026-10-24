// Хранение загруженных файлов (паспорт, фото клиента, скан договора).
// Каждый файл шифруется AES-256-GCM: даже при утечке папки uploads без ключа файлы не прочитать.
// Ключ — FILES_KEY в .env (64 hex-символа) или data/files.key, созданный при первом запуске.
// Ключ нужно хранить в резервной копии ОТДЕЛЬНО от файлов: без него файлы не восстановить.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./db');

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAGIC = Buffer.from('RTE1');

let key = null;
function getKey() {
  if (key) return key;
  if (process.env.FILES_KEY) {
    key = Buffer.from(process.env.FILES_KEY, 'hex');
  } else {
    const file = path.join(DATA_DIR, 'files.key');
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  }
  if (key.length !== 32) throw new Error('FILES_KEY должен быть 64 hex-символа (32 байта)');
  return key;
}

function encrypt(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const body = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

function decrypt(buf) {
  // файлы, сохранённые до включения шифрования, отдаём как есть
  if (buf.length < 32 || !buf.subarray(0, 4).equals(MAGIC)) return buf;
  const d = crypto.createDecipheriv('aes-256-gcm', getKey(), buf.subarray(4, 16));
  d.setAuthTag(buf.subarray(16, 32));
  return Buffer.concat([d.update(buf.subarray(32)), d.final()]);
}

// Сохраняет файл заявки, возвращает относительный путь для таблицы documents
function save(applicationId, prefix, buffer) {
  const dir = path.join(UPLOAD_DIR, String(applicationId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${prefix}-${crypto.randomBytes(10).toString('hex')}.bin`;
  fs.writeFileSync(path.join(dir, name), encrypt(buffer), { mode: 0o600 });
  return `${applicationId}/${name}`;
}

function read(rel) {
  return decrypt(fs.readFileSync(path.join(UPLOAD_DIR, rel)));
}

function remove(rel) {
  fs.rm(path.join(UPLOAD_DIR, rel), { force: true }, () => {});
}

// Проверка содержимого по сигнатуре, а не по расширению
function fileType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length > 4 && buf.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  return null;
}

// Короткие секреты в базе (пароль эквайринга): шифруются тем же ключом, что и файлы
const encryptText = (text) => (text ? `enc:${encrypt(Buffer.from(String(text), 'utf8')).toString('base64')}` : null);
const decryptText = (v) => (v && v.startsWith('enc:') ? decrypt(Buffer.from(v.slice(4), 'base64')).toString('utf8') : v || '');

module.exports = { save, read, remove, fileType, encryptText, decryptText, UPLOAD_DIR };
