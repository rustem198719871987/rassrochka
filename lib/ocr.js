// Распознавание паспорта РФ по фото.
//
// 1. Yandex Vision OCR (модель «passport») — если в админке указан API-ключ и каталог.
//    Даёт все поля разворота, включая «кем выдан» и место рождения; страницу с пропиской
//    читает моделью «page». Данные обрабатываются в РФ.
// 2. Встроенное распознавание (Tesseract, без интернета) — читает машиночитаемую зону
//    внизу страницы с фото: ФИО, пол, дата рождения, серия и номер, дата выдачи, код подразделения.
const path = require('path');
const { getSecret } = require('./db');
const { parseMrz } = require('./mrz');

const yandexConfigured = () => Boolean(getSecret('yandex_api_key') && getSecret('yandex_folder_id'));

// ---------- встроенный OCR ----------
let workerPromise = null;
function tesseract() {
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
    workerPromise = createWorker('eng', 1, { langPath, gzip: true, cacheMethod: 'none' }).then(async (w) => {
      await w.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<' });
      return w;
    }).catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

// Задания выполняются по одному, чтобы не перегружать сервер
let queue = Promise.resolve();
function mrzFromImage(buffer) {
  const job = queue.then(async () => {
    const w = await tesseract();
    const { data } = await w.recognize(buffer);
    return parseMrz(data.text);
  });
  queue = job.catch(() => {});
  return job;
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
async function recognizePassport(buffer, mime) {
  const notes = [];
  if (yandexConfigured()) {
    try {
      const { entities } = await yandexRecognize(buffer, mime, 'passport');
      const fields = fromYandexPassport(entities);
      if (Object.values(fields).some(Boolean)) return { source: 'yandex', fields, uncertain: [], notes };
      notes.push('Yandex Vision не нашёл паспорт на фото');
    } catch (e) {
      notes.push(e.message);
    }
  }
  const mrz = await mrzFromImage(buffer);
  if (!mrz) {
    notes.push('Не удалось прочитать машиночитаемую зону (строки с символами <<< внизу страницы с фото). Переснимите разворот ровно, без бликов.');
    return { source: 'mrz', fields: {}, uncertain: [], notes };
  }
  if (!mrz.valid) notes.push('Часть данных прочитана неуверенно — проверьте выделенные поля.');
  notes.push('«Кем выдан» и место рождения заполните вручную — их можно прочитать только с подключённым Yandex Vision.');
  return { source: 'mrz', fields: mrz.fields, uncertain: mrz.uncertain, notes };
}

async function recognizeRegistration(buffer, mime) {
  if (!yandexConfigured()) return { fields: {}, notes: ['Адрес прописки заполните вручную (фото прикреплено к заявке).'] };
  try {
    const { fullText } = await yandexRecognize(buffer, mime, 'page');
    const address = addressFromText(fullText);
    if (!address) return { fields: {}, notes: ['Адрес на странице с пропиской не найден — заполните вручную.'] };
    return { fields: { reg_address: address }, uncertain: ['reg_address'], notes: ['Адрес прописки распознан со штампа — обязательно сверьте.'] };
  } catch (e) {
    return { fields: {}, notes: [e.message] };
  }
}

module.exports = { recognizePassport, recognizeRegistration, yandexConfigured, addressFromText, fromYandexPassport };
