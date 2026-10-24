// Разбор русского текста, распознанного с разворота паспорта (Tesseract, язык rus).
// Подписи полей мелкие и часто читаются с ошибками («маст рожлене»), а сами данные напечатаны
// крупно и ЗАГЛАВНЫМИ — поэтому опираемся на заглавные слова и на положение строк: дата рождения,
// за ней место рождения, ниже — машиночитаемая зона; сверху — «кем выдан», под ним дата выдачи и код.
const { cyr } = require('./fms');

const DATE = /(\d{2})[.,](\d{2})[.,](\d{4})/;
const iso = (m) => (m ? `${m[3]}-${m[2]}-${m[1]}` : null);
const ru = (isoDate) => (isoDate ? isoDate.split('-').reverse().join('.') : '');
const isMrz = (l) => /<{2,}/.test(l);

// Заглавные слова строки (данные), без подписей и мусора OCR
// короткие служебные слова OCR нередко читает строчными: «УФМС РОССИИ по ТУЛЬСКОЙ ОБЛ.»
const SMALL = new Set(['по', 'в', 'г', 'г.', 'и', 'обл.', 'р-не', 'р-на', 'гор.', 'с.', 'пос.', 'д.']);
function caps(line) {
  const words = String(line).split(/\s+/)
    .map((w) => w.replace(/^[^А-ЯЁа-яёA-Z0-9]+|[^А-ЯЁа-яёA-Z0-9.]+$/g, ''))
    .map((w) => (SMALL.has(w) ? w.toUpperCase() : w));
  const out = words.filter((w) => w && w === w.toUpperCase() && /[А-ЯЁ]/.test(w) && (w.replace(/[^А-ЯЁ]/g, '').length >= 2 || /^[ВГСПД]\.?$/.test(w)));
  // одиночная буква в конце строки — шум (у предлога «В» или «Г.» всегда есть продолжение)
  while (out.length && /^[А-ЯЁA-Z]\.?$/.test(out[out.length - 1])) out.pop();
  return cyr(out.join(' ')).replace(/\s+/g, ' ').trim();
}

const title = (s) => s.toLowerCase().replace(/(^|[\s-])([а-яё])/g, (m, p, c) => p + c.toUpperCase());

function parsePassportText(text, { birthDate } = {}) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = {};
  const mrzAt = lines.findIndex(isMrz);
  const end = mrzAt === -1 ? lines.length : mrzAt;

  // Страница с фото: строка с полом и/или датой рождения
  let birthAt = -1;
  if (birthDate) birthAt = lines.findIndex((l) => l.includes(ru(birthDate)));
  if (birthAt === -1) birthAt = lines.findIndex((l, i) => i < end && /(МУЖ|ЖЕН)/.test(cyr(l)) && DATE.test(l));
  if (birthAt === -1) birthAt = lines.findIndex((l, i) => i < end && /рожд/i.test(l) && DATE.test(l));

  if (birthAt !== -1) {
    const bl = cyr(lines[birthAt]);
    out.birth_date = iso(lines[birthAt].match(DATE));
    out.gender = /ЖЕН/.test(bl) ? 'f' : /МУЖ/.test(bl) ? 'm' : '';
    // место рождения — заглавные слова на строках между датой рождения и МЧЗ (не больше трёх)
    const place = lines.slice(birthAt + 1, Math.min(end, birthAt + 4)).map(caps).filter(Boolean);
    if (place.length) out.birth_place = place.join(' ');
    // ФИО — три строки над строкой с полом: «Фамилия ЩУКИН», «Имя ЮРИЙ», «Отчество ИЛЬИЧ»
    // (подпись читается с ошибками, а значение — последнее слово строки)
    const names = lines.slice(Math.max(0, birthAt - 3), birthAt).map((l) => cyr(l.split(/\s+/).pop().replace(/[^А-ЯЁа-яёA-Za-z0-9-]/g, '')));
    if (names.length === 3 && names.every((n) => /^[А-ЯЁ][А-ЯЁ-]+$/.test(n))) {
      [out.last_name, out.first_name, out.middle_name] = names.map(title);
    }
  }

  // Верхняя страница: «Паспорт выдан …», затем строка с датой выдачи и кодом подразделения
  const codeAt = lines.findIndex((l) => /\d{3}\s?[-–—]\s?\d{3}(?!\d)/.test(l) && !isMrz(l));
  if (codeAt !== -1) {
    const code = lines[codeAt].match(/(\d{3})\s?[-–—]\s?(\d{3})(?!\d)/);
    out.passport_dept_code = `${code[1]}-${code[2]}`;
    out.passport_issue_date = iso(lines[codeAt].match(DATE));
    let from = lines.findIndex((l, i) => i < codeAt && /выдан/i.test(l));
    if (from === -1) from = lines.findIndex((l, i) => i < codeAt && /ФЕДЕРАЦ/.test(cyr(l)));
    const issued = lines.slice(from + 1, codeAt).map(caps).filter(Boolean);
    if (issued.length) out.issued_by_text = issued.join(' ');
  }
  return out;
}

module.exports = { parsePassportText, caps };
