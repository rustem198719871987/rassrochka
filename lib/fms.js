// «Кем выдан» по коду подразделения — по открытому справочнику DaData (lib/data/fms_unit.csv.gz),
// без платных сервисов. У одного кода бывает несколько названий (до 2016 года паспорта выдавала ФМС,
// потом МВД, плюс отделы внутри управления), поэтому выбираем подходящее по тексту с фото и дате выдачи.
// Справочник: lib/data/fms_unit.csv.gz, лицензия CC BY-SA 4.0 (см. lib/data/README.md).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let units = null;
function load() {
  if (units) return units;
  units = new Map();
  const csv = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'data', 'fms_unit.csv.gz'))).toString('utf8');
  for (const line of csv.split('\n').slice(1)) {
    const m = line.match(/^(\d{3}-\d{3}),"?(.*?)"?\r?$/);
    if (!m) continue;
    const name = m[2].replace(/""/g, '"').trim();
    if (!units.has(m[1])) units.set(m[1], []);
    units.get(m[1]).push(name);
  }
  return units;
}

const normCode = (code) => {
  const d = String(code || '').replace(/\D/g, '');
  return d.length === 6 ? `${d.slice(0, 3)}-${d.slice(3)}` : null;
};

function candidates(code) {
  const c = normCode(code);
  return (c && load().get(c)) || [];
}

// OCR путает похожие латинские буквы и ноль с кириллицей: в словах с кириллицей заменяем их
const LOOKALIKE = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У', 0: 'О', 3: 'З' };
const cyr = (s) => String(s || '').toUpperCase().replace(/[A-ZА-ЯЁ0-9]+/g, (w) => (/[А-ЯЁ]/.test(w) ? w.replace(/[ABCEHKMOPTXY03]/g, (c) => LOOKALIKE[c]) : w));
const words = (s) => cyr(s).replace(/Ё/g, 'Е').replace(/Й/g, 'И').replace(/[^А-Я0-9]+/g, ' ').split(' ').filter((w) => w.length >= 2);

// Похожесть названия на распознанный текст: доля слов названия, найденных в тексте, и доля слов текста,
// объяснённых названием (с допуском на ошибки OCR в окончаниях)
function similarity(name, text) {
  const nw = words(name);
  const tw = words(text);
  if (!nw.length || !tw.length) return 0;
  const same = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));
  const recall = nw.filter((w) => tw.some((t) => same(w, t))).length / nw.length;
  const precision = tw.filter((t) => nw.some((w) => same(w, t))).length / tw.length;
  return recall < 0.6 ? 0 : (recall + precision) / 2;
}

const FMS_ERA = /ФМС|ОВД|ПВС|ПАСПОРТНО|МИЛИЦИИ/;
const MVD_ERA = /МВД|ОВМ|ВОПРОСАМ МИГРАЦИИ/;

let vocab = null;
// Доля слов текста, которые встречаются в названиях подразделений: так видно, что OCR прочитал текст чисто
function cleanRatio(text) {
  if (!vocab) { vocab = new Set(); for (const names of load().values()) for (const n of names) for (const w of words(n)) vocab.add(w); }
  const tw = words(text);
  return tw.length ? tw.filter((w) => vocab.has(w)).length / tw.length : 0;
}

// «Кем выдан» для кода подразделения: { value, options, sure }.
// Совпало со справочником — берём название оттуда (без ошибок OCR). Текст с фото прочитан чисто, но в справочнике
// такого варианта нет — берём текст с фото. Иначе — вариант из справочника по дате выдачи. options — все варианты кода.
function issuedBy(code, { issueDate, text } = {}) {
  const list = candidates(code);
  if (text && list.length) {
    const scored = list.map((name) => ({ name, score: similarity(name, text) })).sort((a, b) => b.score - a.score);
    if (scored[0].score >= 0.9 && (scored.length === 1 || scored[0].score > scored[1].score)) return { value: scored[0].name, options: list, sure: true };
  }
  const clean = text ? cyr(text).replace(/\s+/g, ' ').trim() : '';
  if (clean && words(clean).length >= 3 && cleanRatio(clean) >= 0.9) return { value: clean, options: list, sure: false };
  if (!list.length) return clean ? { value: clean, options: [], sure: false } : null;
  if (list.length === 1) return { value: list[0], options: list, sure: !text };
  // по дате: до середины 2016 года — подразделения ФМС, позже — МВД; среди них самое общее (короткое) название
  const era = issueDate && issueDate < '2016-07-01' ? FMS_ERA : MVD_ERA;
  const preferred = list.filter((n) => era.test(n) && !(era === MVD_ERA && FMS_ERA.test(n)));
  const pool = preferred.length ? preferred : list;
  return { value: pool.slice().sort((a, b) => a.length - b.length)[0], options: list, sure: false };
}

module.exports = { candidates, issuedBy, normCode, similarity, cleanRatio, cyr };
