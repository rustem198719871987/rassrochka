// Страница для телефона продавца: открывается по QR-коду с компьютера, без входа в кабинет.
// Доступ даёт одноразовый токен в ссылке (действует 30 минут).
// Два режима: фото паспорта для анкеты и постраничная съёмка подписанного договора.
const express = require('express');
const multer = require('multer');
const { db, getSettings } = require('../lib/db');
const storage = require('../lib/storage');
const ocr = require('../lib/ocr');

const router = express.Router();
const PASSPORT_KINDS = ['passport_main', 'passport_reg', 'client_photo'];
const MAX_PAGES = 30;

router.use((req, res, next) => {
  res.locals.settings = getSettings();
  res.locals.flash = null;
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: MAX_PAGES + 3 },
});

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
  const view = s && s.purpose === 'contract' ? 'mobile/contract' : 'mobile/upload';
  res.render(view, { title: s && s.purpose === 'contract' ? 'Скан договора' : 'Фото документов', s, state, maxPages: MAX_PAGES });
});

const fields = upload.fields([...PASSPORT_KINDS.map((name) => ({ name, maxCount: 1 })), { name: 'pages', maxCount: MAX_PAGES }]);

// Ссылка проверяется до приёма файлов: без действующего токена фото даже не загружаются в память сервера
function checkToken(req, res, next) {
  const s = loadSession(req.params.token);
  if (!s || s.expires_at < Date.now()) return res.status(410).json({ error: 'Ссылка устарела. Покажите на компьютере новый QR-код.' });
  if (s.status !== 'waiting' && s.status !== 'error') return res.status(409).json({ error: 'Фото по этой ссылке уже отправлены.' });
  req.scan = s;
  next();
}

router.post('/:token', checkToken, fields, async (req, res) => {
  // повторная проверка после загрузки: пока шли файлы, по этой ссылке могли уже отправить фото
  const s = loadSession(req.params.token);
  if (!s || (s.status !== 'waiting' && s.status !== 'error')) return res.status(409).json({ error: 'Фото по этой ссылке уже отправлены.' });

  if (s.purpose === 'contract') return saveContract(s, req, res);

  const files = {};
  for (const kind of PASSPORT_KINDS) {
    const f = req.files && req.files[kind] && req.files[kind][0];
    if (!f) continue;
    const mime = storage.fileType(f.buffer);
    if (mime !== 'image/jpeg' && mime !== 'image/png') return res.status(400).json({ error: 'Поддерживаются только фото JPEG и PNG' });
    files[kind] = { buffer: f.buffer, mime };
  }
  if (!files.passport_main) return res.status(400).json({ error: 'Добавьте фото разворота паспорта с фотографией' });

  // новые фото заменяют прежние того же вида
  db.transaction(() => {
    for (const [kind, f] of Object.entries(files)) {
      for (const old of db.prepare('SELECT * FROM documents WHERE application_id = ? AND kind = ?').all(s.application_id, kind)) {
        storage.remove(old.file);
      }
      db.prepare('DELETE FROM documents WHERE application_id = ? AND kind = ?').run(s.application_id, kind);
      db.prepare('INSERT INTO documents (application_id, kind, file, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(s.application_id, kind, storage.save(s.application_id, kind, f.buffer), f.mime, f.buffer.length, s.created_by);
    }
    db.prepare("UPDATE scan_sessions SET status = 'processing', error = NULL WHERE id = ?").run(s.id);
  })();
  res.json({ ok: true });

  // распознаём после ответа — телефон не ждёт
  try {
    const passport = await ocr.recognizePassport(files.passport_main.buffer, files.passport_main.mime);
    const reg = files.passport_reg ? await ocr.recognizeRegistration(files.passport_reg.buffer, files.passport_reg.mime) : { fields: {}, notes: [] };
    const found = {};
    for (const [k, v] of Object.entries({ ...passport.fields, ...reg.fields })) if (v) found[k] = v;
    const result = {
      source: passport.source,
      fields: found,
      uncertain: [...(passport.uncertain || []), ...(reg.uncertain || [])],
      notes: [...passport.notes, ...reg.notes],
    };
    db.prepare("UPDATE scan_sessions SET status = 'done', result = ? WHERE id = ?").run(JSON.stringify(result), s.id);
  } catch (e) {
    console.error('Ошибка распознавания:', e);
    db.prepare("UPDATE scan_sessions SET status = 'error', error = ? WHERE id = ?").run('Не удалось распознать фото. Заполните данные вручную.', s.id);
  }
});

// Страницы подписанного договора добавляются к уже загруженным
function saveContract(s, req, res) {
  const pages = (req.files && req.files.pages) || [];
  if (!pages.length) return res.status(400).json({ error: 'Сфотографируйте хотя бы одну страницу договора' });
  for (const f of pages) {
    const mime = storage.fileType(f.buffer);
    if (mime !== 'image/jpeg' && mime !== 'image/png') return res.status(400).json({ error: 'Поддерживаются только фото JPEG и PNG' });
  }
  addContractPages(s.application_id, pages.map((f) => f.buffer), s.created_by);
  db.prepare("UPDATE scan_sessions SET status = 'done', result = ? WHERE id = ?").run(JSON.stringify({ pages: pages.length }), s.id);
  res.json({ ok: true, pages: pages.length });
}

function addContractPages(applicationId, buffers, userId) {
  return db.transaction(() => {
    let page = db.prepare("SELECT coalesce(max(page), 0) p FROM documents WHERE application_id = ? AND kind = 'contract_page'").get(applicationId).p;
    for (const buf of buffers) {
      page += 1;
      db.prepare('INSERT INTO documents (application_id, kind, page, file, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(applicationId, 'contract_page', page, storage.save(applicationId, 'contract', buf), storage.fileType(buf), buf.length, userId);
    }
    return page;
  })();
}

router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = { LIMIT_FILE_SIZE: 'Файл больше 12 МБ', LIMIT_FILE_COUNT: `Не больше ${MAX_PAGES} страниц за раз` }[err.code] || 'Ошибка загрузки файла';
    return res.status(400).json({ error: msg });
  }
  next(err);
});

module.exports = router;
module.exports.addContractPages = addContractPages;
module.exports.MAX_PAGES = MAX_PAGES;
