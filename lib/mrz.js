// Машиночитаемая зона (МЧЗ) внутреннего паспорта РФ — две строки по 44 символа внизу
// страницы с фотографией. ФИО в ней записано латиницей по обратимой таблице, поэтому
// кириллица восстанавливается точно, а контрольные цифры позволяют проверить распознавание.
//
// Строка 1: PNRUS ФАМИЛИЯ << ИМЯ < ОТЧЕСТВО <<<...
// Строка 2: 1–9 серия (3 цифры) + номер, 10 к/ц, 11–13 RUS, 14–19 дата рождения, 20 к/ц, 21 пол,
//           22–28 «<», 29 последняя цифра серии, 30–35 дата выдачи, 36–41 код подразделения,
//           42 «<», 43 к/ц доп. данных, 44 общая к/ц.

const LAT_TO_CYR = {
  A: 'А', B: 'Б', V: 'В', G: 'Г', D: 'Д', E: 'Е', 2: 'Ё', J: 'Ж', Z: 'З', I: 'И', Q: 'Й', K: 'К', L: 'Л',
  M: 'М', N: 'Н', O: 'О', P: 'П', R: 'Р', S: 'С', T: 'Т', U: 'У', F: 'Ф', H: 'Х', C: 'Ц', 3: 'Ч', 4: 'Ш',
  W: 'Щ', X: 'Ъ', Y: 'Ы', 9: 'Ь', 6: 'Э', 7: 'Ю', 8: 'Я',
};
const CYR_TO_LAT = Object.fromEntries(Object.entries(LAT_TO_CYR).map(([l, c]) => [c, l]));

function checkDigit(s) {
  const w = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const v = ch === '<' ? 0 : /\d/.test(ch) ? Number(ch) : ch.charCodeAt(0) - 55;
    sum += v * w[i % 3];
  }
  return String(sum % 10);
}

const toCyr = (s) => s.split('').map((ch) => LAT_TO_CYR[ch] || '').join('');
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s-])([а-яё])/g, (m, p, c) => p + c.toUpperCase());

function mrzDate(yymmdd, { future = false } = {}) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const nowYY = new Date().getFullYear() % 100;
  const century = future ? 2000 : (yy > nowYY ? 1900 : 2000);
  return `${century + yy}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

// Типичные ошибки OCR в цифровых позициях
const digitFix = (s) => s.replace(/[OQD]/g, '0').replace(/[IL]/g, '1').replace(/Z/g, '2').replace(/S/g, '5').replace(/B/g, '8').replace(/G/g, '6');

// Вторая строка выравнивается по «RUS» (позиции 11–13): OCR часто теряет или добавляет символ в начале
function alignLine2(l) {
  const at = l.indexOf('RUS', 6);
  if (at === -1 || at > 14) return l.padEnd(44, '<').slice(0, 44);
  return (at < 10 ? '<'.repeat(10 - at) + l : l.slice(at - 10)).padEnd(44, '<').slice(0, 44);
}

// Ищет строки МЧЗ в произвольном тексте OCR. Если первая строка (ФИО) не прочиталась,
// хватает второй: в ней серия, номер, даты, пол и код подразделения с контрольными цифрами.
function findMrzLines(text) {
  const lines = String(text || '')
    .toUpperCase()
    .replace(/[«‹(\[{]/g, '<')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, '').replace(/[^A-Z0-9<]/g, ''))
    .filter((l) => l.length >= 30);
  for (let i = 0; i < lines.length; i++) {
    const p = lines[i].indexOf('PNRUS');
    if (p === -1) continue;
    const l1 = lines[i].slice(p);
    const l2 = lines[i + 1];
    if (l2 && l2.length >= 36) return [l1.padEnd(44, '<').slice(0, 44), alignLine2(l2)];
  }
  const l2 = lines.find((l) => l.length >= 36 && /RUS\d/.test(l) && /\d{5}/.test(l.slice(0, 12)));
  return l2 ? ['PNRUS'.padEnd(44, '<'), alignLine2(l2)] : null;
}

function parseMrz(text) {
  const found = findMrzLines(text);
  if (!found) return null;
  const [l1, rawL2] = found;
  const l2 = digitFix(rawL2.slice(0, 10)) + rawL2.slice(10, 13) + digitFix(rawL2.slice(13, 20)) + rawL2[20] + rawL2.slice(21, 28) + digitFix(rawL2.slice(28, 44));

  const names = l1.slice(5).split('<<').filter(Boolean);
  const surname = (names[0] || '').replace(/</g, '');
  const [first = '', middle = ''] = (names[1] || '').split('<').filter(Boolean);

  const series3 = l2.slice(0, 3);
  const number = l2.slice(3, 9);
  const seriesLast = l2[28];
  const birth = l2.slice(13, 19);
  const issue = l2.slice(29, 35);
  const dept = l2.slice(35, 41);

  const checks = {
    number: checkDigit(l2.slice(0, 9)) === l2[9],
    birth: checkDigit(birth) === l2[19],
    optional: checkDigit(l2.slice(28, 42)) === l2[42],
  };

  const isDate = (d) => /^\d{6}$/.test(d) && Number(d.slice(2, 4)) >= 1 && Number(d.slice(2, 4)) <= 12;
  const fields = {
    last_name: titleCase(toCyr(surname)),
    first_name: titleCase(toCyr(first)),
    middle_name: titleCase(toCyr(middle)),
    gender: l2[20] === 'F' ? 'f' : l2[20] === 'M' ? 'm' : '',
    birth_date: isDate(birth) ? mrzDate(birth) : null,
    passport_series: /^\d{3}$/.test(series3) && /^\d$/.test(seriesLast) ? series3 + seriesLast : null,
    passport_number: /^\d{6}$/.test(number) ? number : null,
    passport_issue_date: isDate(issue) ? mrzDate(issue, { future: true }) : null,
    passport_dept_code: /^\d{6}$/.test(dept) ? `${dept.slice(0, 3)}-${dept.slice(3)}` : null,
  };
  // поля, у которых не сошлась контрольная цифра — показываем продавцу как «проверьте»
  const uncertain = [];
  if (!surname) uncertain.push('names');
  if (!checks.number) uncertain.push('passport_series', 'passport_number');
  if (!checks.birth) uncertain.push('birth_date');
  // контрольная цифра случайно сходится в 1 случае из 10 — дату выдачи дополнительно сверяем со здравым смыслом
  const plausibleIssue = fields.passport_issue_date && fields.birth_date && fields.passport_issue_date > fields.birth_date.replace(/^\d{4}/, (y) => Number(y) + 13)
    && fields.passport_issue_date <= new Date().toISOString().slice(0, 10);
  if (!checks.optional || !plausibleIssue) uncertain.push('passport_issue_date', 'passport_dept_code');
  return { source: 'mrz', valid: !uncertain.length, uncertain, fields, numberCheck: l2[9] };
}

// Для тестов: собирает МЧЗ из данных
function buildMrz({ last_name, first_name, middle_name, gender, birth_date, passport_series, passport_number, passport_issue_date, passport_dept_code }) {
  const lat = (s) => String(s || '').toUpperCase().split('').map((c) => CYR_TO_LAT[c] || '').join('');
  const l1 = `PNRUS${lat(last_name)}<<${lat(first_name)}<${lat(middle_name)}`.padEnd(44, '<').slice(0, 44);
  const ymd = (d) => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);
  const docNo = passport_series.slice(0, 3) + passport_number;
  const opt = passport_series[3] + ymd(passport_issue_date) + passport_dept_code.replace('-', '') + '<';
  const head = docNo + checkDigit(docNo) + 'RUS' + ymd(birth_date) + checkDigit(ymd(birth_date)) + (gender === 'f' ? 'F' : 'M') + '<<<<<<<';
  const body = head + opt + checkDigit(opt);
  const composite = checkDigit(body.slice(0, 10) + body.slice(13, 20) + body.slice(21, 43));
  return [l1, body + composite];
}

module.exports = { parseMrz, buildMrz, checkDigit, findMrzLines };
