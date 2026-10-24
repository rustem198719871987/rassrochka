// Распознавание паспорта РФ по фото.
//
// 1. Встроенное распознавание (Tesseract, бесплатно, без интернета):
//    — машиночитаемая зона внизу страницы с фото: ФИО, пол, дата рождения, серия и номер, дата выдачи,
//      код подразделения (с контрольными цифрами);
//    — русский текст разворота: место рождения и «кем выдан»; «кем выдан» сверяется со справочником
//      подразделений по коду (lib/fms.js);
//    — страница с пропиской: адрес со штампа «Зарегистрирован».
// 2. Yandex Vision OCR — только если в админке указан API-ключ (платно, обычно не нужно).
const path = require('path');
const { getSecret } = require('./db');
const { parseMrz, checkDigit } = require('./mrz');
const { parsePassportText } = require('./passport-text');
const fms = require('./fms');

const yandexConfigured = () => Boolean(getSecret('yandex_api_key') && getSecret('yandex_folder_id'));

// ---------- встроенный OCR ----------
// Два распознавателя: латиница с цифрами для МЧЗ и русский. Держим их в памяти, пока идут фото,
// и выгружаем через 5 минут простоя, чтобы не занимать память сервера.
const LANGS = {
  eng: { pkg: '@tesseract.js-data/eng', params: { tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<' } },
  rus: { pkg: '@tesseract.js-data/rus', params: {} },
};
const workers = {};
const IDLE_MS = 5 * 60e3;
function tesseract(lang) {
  const slot = workers[lang] || (workers[lang] = {});
  clearTimeout(slot.timer);
  if (!slot.promise) {
    const { createWorker } = require('tesseract.js');
    const langPath = path.join(path.dirname(require.resolve(`${LANGS[lang].pkg}/package.json`)), '4.0.0_best_int');
    slot.promise = createWorker(lang, 1, { langPath, gzip: true, cacheMethod: 'none' }).then(async (w) => {
      await w.setParameters(LANGS[lang].params);
      return w;
    }).catch((e) => { slot.promise = null; throw e; });
  }
  return slot.promise;
}
function release(lang) {
  const slot = workers[lang];
  slot.timer = setTimeout(() => {
    const p = slot.promise;
    slot.promise = null;
    if (p) p.then((w) => w.terminate()).catch(() => {});
  }, IDLE_MS);
  slot.timer.unref();
}

// Задания выполняются по одному, чтобы не перегружать сервер
let queue = Promise.resolve();
function ocrText(buffer, lang, opts = {}) {
  const job = queue.then(async () => {
    const w = await tesseract(lang);
    try {
      const { data } = await w.recognize(buffer, opts);
      return data.text;
    } finally { release(lang); }
  });
  queue = job.catch(() => {});
  return job;
}
const mrzFromImage = async (buffer) => parseMrz(await ocrText(buffer, 'eng'));

// Серия и номер, напечатанные красным вертикально у края страниц: читаем фото, повёрнутое на 90°
async function verticalNumber(buffer) {
  for (const rotateRadians of [-Math.PI / 2, Math.PI / 2]) {
    const text = await ocrText(buffer, 'eng', { rotateRadians }).catch(() => '');
    const m = text.replace(/[OQD]/g, '0').match(/(?<!\d)(\d{2})\s?(\d{2})\s?(\d{6})(?!\d)/);
    if (m) return { series: m[1] + m[2], number: m[3] };
  }
  return null;
}

// ---------- Yandex Vision ----------
async function yandexRecognize(buffer, mime, model) {
  const res = await fetch('https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Api-Key ${getSecret('yandex_api_key')}`,
      'x-folder-id': getSecret('yandex_folder_id'),
    },
    body: JSON.stringify({
      mimeType: mime === 'image/png' ? 'PNG' : 'JPEG',
      languageCodes: ['ru'],
      model,
      content: buffer.toString('base64'),
    }),
    signal: AbortSignal.timeout(30000),
  }).catch(() => { throw new Error('Yandex Vision недоступен — использовано встроенное распознавание'); });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Yandex Vision: ${(data && data.message) || `HTTP ${res.status}`}`);
  const ann = (data && data.result && data.result.textAnnotation) || {};
  return { entities: ann.entities || [], fullText: ann.fullText || '' };
}

const ruDate = (s) => {
  const m = String(s || '').match(/(\d{2})[.\s/-](\d{2})[.\s/-](\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
const title = (s) => String(s || '').trim().toLowerCase().replace(/(^|[\s.-])([а-яё])/g, (m, p, c) => p + c.toUpperCase());

function fromYandexPassport(entities) {
  const e = {};
  for (const it of entities) e[String(it.name).toLowerCase()] = String(it.text || '').trim();
  const digits = (e.number || '').replace(/\D/g, '');
  const dept = (e.subdivision || e.department_code || '').replace(/\D/g, '');
  const g = (e.gender || '').toLowerCase();
  return {
    last_name: title(e.surname),
    first_name: title(e.name),
    middle_name: title(e.middle_name || e.patronymic),
    gender: /^(м|m)/.test(g) ? 'm' : /^(ж|f)/.test(g) ? 'f' : '',
    birth_date: ruDate(e.birth_date),
    birth_place: e.birth_place ? e.birth_place.toUpperCase() : '',
    passport_series: digits.length === 10 ? digits.slice(0, 4) : null,
    passport_number: digits.length === 10 ? digits.slice(4) : null,
    passport_issued_by: e.issued_by ? e.issued_by.toUpperCase() : '',
    passport_issue_date: ruDate(e.issue_date),
    passport_dept_code: dept.length === 6 ? `${dept.slice(0, 3)}-${dept.slice(3)}` : null,
  };
}

// Адрес со штампа о регистрации: строки после «Зарегистрирован», похожие на адрес
const ADDRESS_HINT = /(^|[\s,.])(обл|область|край|респ|г|гор|город|р-н|район|пос|п|с|село|дер|ул|улица|пр-т|просп|пер|ш|шоссе|наб|б-р|мкр|д|дом|корп|стр|кв)(?=[\s.,]|$)/i;
const NOT_ADDRESS = /(зарегистрир|снят|выдан|подпись|отдел|мвд|уфмс|гувд|код\s+подр|место\s+жительства|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|\d{1,2}\.\d{2}\.\d{4})/i;
function addressFromText(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // берём последний штамп «Зарегистрирован» на странице — он актуальный
  let start = -1;
  lines.forEach((l, i) => { if (/зарегистрир/i.test(l)) start = i; });
  const picked = [];
  for (const l of lines.slice(start + 1, start + 12)) {
    if (NOT_ADDRESS.test(l)) {
      if (picked.length && /отдел|мвд|уфмс|гувд|подпись/i.test(l)) break;
      continue;
    }
    if (ADDRESS_HINT.test(l)) picked.push(l.replace(/^[^А-Яа-яЁё0-9]+/, ''));
  }
  return picked.join(', ').replace(/\s+/g, ' ').trim();
}

// ---------- публичные функции ----------
// «Кем выдан»: справочник по коду + текст с фото. options — варианты для выбора в анкете.
function addIssuedBy(res, text) {
  const f = res.fields;
  if (!f.passport_dept_code) return;
  const ib = fms.issuedBy(f.passport_dept_code, { issueDate: f.passport_issue_date, text: text || f.passport_issued_by });
  if (!ib) return;
  f.passport_issued_by = ib.value;
  if (!ib.sure) res.uncertain.push('passport_issued_by');
  if (ib.options.length > 1) res.options = { passport_issued_by: ib.options };
}

async function recognizePassport(buffer, mime) {
  const notes = [];
  if (yandexConfigured()) {
    try {
      const { entities } = await yandexRecognize(buffer, mime, 'passport');
      const fields = fromYandexPassport(entities);
      if (Object.values(fields).some(Boolean)) {
        const res = { source: 'yandex', fields, uncertain: [], notes };
        addIssuedBy(res);
        return res;
      }
      notes.push('Yandex Vision не нашёл паспорт на фото');
    } catch (e) {
      notes.push(e.message);
    }
  }
  const mrz = await mrzFromImage(buffer).catch(() => null);
  const text = parsePassportText(await ocrText(buffer, 'rus').catch(() => ''), { birthDate: mrz && mrz.fields.birth_date });
  const res = { source: 'ocr', fields: {}, uncertain: [], notes };
  const fromText = (keys) => keys.forEach((k) => { if (text[k] && !res.fields[k]) { res.fields[k] = text[k]; res.uncertain.push(k); } });
  if (mrz) {
    for (const [k, v] of Object.entries(mrz.fields)) if (v) res.fields[k] = v;
    res.uncertain.push(...mrz.uncertain.filter((k) => k !== 'names'));
  }
  // чего нет в МЧЗ (или МЧЗ не прочиталась) — из русского текста, всё под проверку
  fromText(['last_name', 'first_name', 'middle_name', 'gender', 'birth_date', 'passport_issue_date', 'passport_dept_code']);
  // серия и номер не прочитаны или не сошлась контрольная цифра — читаем красные цифры у края страницы
  if (!res.fields.passport_series || !res.fields.passport_number || res.uncertain.includes('passport_number')) {
    const v = await verticalNumber(buffer);
    if (v) {
      const verified = mrz && checkDigit(v.series.slice(0, 3) + v.number) === mrz.numberCheck;
      res.fields.passport_series = v.series;
      res.fields.passport_number = v.number;
      res.uncertain = res.uncertain.filter((k) => !['passport_series', 'passport_number'].includes(k));
      if (!verified) res.uncertain.push('passport_series', 'passport_number');
    }
  }
  if (!mrz || !mrz.valid) notes.push('Часть данных прочитана неуверенно — проверьте выделенные поля. Для точного результата переснимите разворот ровно, без бликов, чтобы строки с символами <<< внизу были чёткими.');
  if (text.birth_place) { res.fields.birth_place = text.birth_place; res.uncertain.push('birth_place'); }
  addIssuedBy(res, text.issued_by_text);
  if (!Object.keys(res.fields).length) {
    notes.length = 0;
    notes.push('Паспорт на фото не распознан. Переснимите разворот с фото целиком, ровно и без бликов, или заполните вручную.');
  }
  const missing = [!res.fields.passport_number && 'серию и номер', !res.fields.birth_place && 'место рождения', !res.fields.passport_issued_by && '«кем выдан»'].filter(Boolean);
  if (missing.length && Object.keys(res.fields).length) notes.push(`Заполните вручную: ${missing.join(', ')}.`);
  return res;
}

async function recognizeRegistration(buffer, mime) {
  let text = '';
  const notes = [];
  if (yandexConfigured()) {
    try { text = (await yandexRecognize(buffer, mime, 'page')).fullText; } catch (e) { notes.push(e.message); }
  }
  if (!text) text = await ocrText(buffer, 'rus').catch(() => '');
  const address = addressFromText(text);
  if (!address) return { fields: {}, notes: [...notes, 'Адрес на странице с пропиской не найден — заполните вручную (фото прикреплено к заявке).'] };
  return { fields: { reg_address: address }, uncertain: ['reg_address'], notes: [...notes, 'Адрес прописки распознан со штампа — обязательно сверьте.'] };
}

module.exports = { recognizePassport, recognizeRegistration, yandexConfigured, addressFromText, fromYandexPassport };
