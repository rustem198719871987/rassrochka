// Страница для телефона продавца: открывается по QR-коду из анкеты, без входа в кабинет.
// Доступ даёт одноразовый токен в ссылке (действует 30 минут).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { db, DATA_DIR, getSettings } = require('../lib/db');
const ocr = require('../lib/ocr');

const router = express.Router();
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const KINDS = ['passport_main', 'passport_reg', 'client_photo'];

router.use((req, res, next) => {
  res.locals.settings = getSettings();
  res.locals.flash = null;
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 3 },
});

function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return { mime: 'image/png', ext: 'png' };
  return null;
}

function loadSession(token) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token || '')) return null;
  const s = db.prepare('SELECT * FROM scan_sessions WHERE token = ?').get(token);
  if (!s) return null;
  s.app = db.prepare('SELECT id, number FROM applications WHERE id = ?').get(s.application_id);
  return s;
}

router.get('/:token', (req, res) => {
  const s = loadSession(req.params.token);
  res.set('Cache-Control', 'no-store');
  let state = 'ok';
  if (!s) state = 'invalid';
  else if (s.status === 'processing' || s.status === 'done') state = 'sent';
  else if (s.expires_at < Date.now()) state = 'expired';
  res.render('mobile/upload', { title: 'Фото документов', s, state, token: req.params.token });
});

router.post('/:token', upload.fields(KINDS.map((name) => ({ name, maxCount: 1 }))), async (req, res) => {
  const s = loadSession(req.params.token);
  if (!s || s.expires_at < Date.now()) return res.status(410).json({ error: 'Ссылка устарела. Покажите на компьютере новый QR-код.' });
  if (s.status !== 'waiting' && s.status !== 'error') return res.status(409).json({ error: 'Фото по этой ссылке уже отправлены.' });

  const files = {};
  for (const kind of KINDS) {
    const f = req.files && req.files[kind] && req.files[kind][0];
    if (!f) continue;
    const type = imageType(f.buffer);
    if (!type) return res.status(400).json({ error: 'Поддерживаются только фото JPEG и PNG' });
    files[kind] = { buffer: f.buffer, ...type };
  }
  if (!files.passport_main) return res.status(400).json({ error: 'Добавьте фото разворота паспорта с фотографией' });

  // сохраняем файлы и привязываем к заявке (новые фото заменяют прежние того же вида)
  const dir = path.join(UPLOAD_DIR, String(s.application_id));
  fs.mkdirSync(dir, { recursive: true });
  db.transaction(() => {
    for (const [kind, f] of Object.entries(files)) {
      const name = `${kind}-${crypto.randomBytes(8).toString('hex')}.${f.ext}`;
      fs.writeFileSync(path.join(dir, name), f.buffer, { mode: 0o600 });
      for (const old of db.prepare('SELECT * FROM documents WHERE application_id = ? AND kind = ?').all(s.application_id, kind)) {
        fs.rm(path.join(UPLOAD_DIR, old.file), () => {});
      }
      db.prepare('DELETE FROM documents WHERE application_id = ? AND kind = ?').run(s.application_id, kind);
      db.prepare('INSERT INTO documents (application_id, kind, file, mime, size) VALUES (?, ?, ?, ?, ?)')
        .run(s.application_id, kind, `${s.application_id}/${name}`, f.mime, f.buffer.length);
    }
    db.prepare("UPDATE scan_sessions SET status = 'processing', error = NULL WHERE id = ?").run(s.id);
  })();
  res.json({ ok: true });

  // распознаём после ответа — телефон не ждёт
  try {
    const passport = await ocr.recognizePassport(files.passport_main.buffer, files.passport_main.mime);
    const reg = files.passport_reg ? await ocr.recognizeRegistration(files.passport_reg.buffer, files.passport_reg.mime) : { fields: {}, notes: [] };
    const fields = {};
    for (const [k, v] of Object.entries({ ...passport.fields, ...reg.fields })) if (v) fields[k] = v;
    const result = {
      source: passport.source,
      fields,
      uncertain: [...(passport.uncertain || []), ...(reg.uncertain || [])],
      notes: [...passport.notes, ...reg.notes],
    };
    db.prepare("UPDATE scan_sessions SET status = 'done', result = ? WHERE id = ?").run(JSON.stringify(result), s.id);
  } catch (e) {
    console.error('Ошибка распознавания:', e);
    db.prepare("UPDATE scan_sessions SET status = 'error', error = ? WHERE id = ?").run('Не удалось распознать фото. Заполните данные вручную.', s.id);
  }
});

router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Файл больше 12 МБ' : 'Ошибка загрузки файла' });
  }
  next(err);
});

module.exports = router;
module.exports.UPLOAD_DIR = UPLOAD_DIR;
