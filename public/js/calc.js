// Расчёт рассрочки. Общий код для сервера (require) и браузера (window.Calc).
// Все суммы — в копейках (целые числа), чтобы не терять точность.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Calc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Торговая наценка: markupPercent % от стоимости товара за каждый месяц.
  // 1 мес — 3 %, 2 мес — 6 %, 3 мес — 9 % и т. д.
  function calculate(opts) {
    var price = Math.round(opts.price);
    var down = Math.round(opts.downPayment || 0);
    var months = Math.round(opts.months);
    var markupPercent = Number(opts.markupPercent);

    var markupTotalPercent = markupPercent * months;
    var markup = Math.round(price * markupTotalPercent / 100);
    var total = price + markup;
    var financed = total - down;

    var regular = Math.round(financed / months);
    var payments = [];
    for (var i = 0; i < months; i++) payments.push(regular);
    // последний платёж выравнивает копейки
    payments[months - 1] = financed - regular * (months - 1);

    return {
      price: price,
      downPayment: down,
      months: months,
      markupPercent: markupPercent,
      markupTotalPercent: markupTotalPercent,
      markup: markup,
      total: total,
      financed: financed,
      monthly: regular,
      payments: payments,
    };
  }

  // Прибавляет месяцы к дате; 31 января + 1 мес = 28/29 февраля
  function addMonths(date, n) {
    var d = new Date(date.getFullYear(), date.getMonth() + n, 1);
    var lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(date.getDate(), lastDay));
    return d;
  }

  function schedule(calc, startDate) {
    return calc.payments.map(function (amount, i) {
      return { n: i + 1, date: addMonths(startDate, i + 1), amount: amount };
    });
  }

  function money(kopecks) {
    var rub = kopecks / 100;
    return rub.toLocaleString('ru-RU', {
      minimumFractionDigits: kopecks % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }) + ' ₽';
  }

  // Вознаграждение продавца: rates = { 1: 0, 2: 1, 3: 2.5 } — «срок от N мес → процент».
  // База — сумма по договору (total) или цена товара (price).
  function commissionRate(months, rates) {
    var rate = 0;
    Object.keys(rates || {}).map(Number).sort(function (a, b) { return a - b; }).forEach(function (m) {
      if (months >= m) rate = Number(rates[m]);
    });
    return rate;
  }

  function commission(opts) {
    var percent = commissionRate(opts.months, opts.rates);
    var base = opts.base === 'price' ? opts.price : opts.total;
    return { percent: percent, amount: Math.round(base * percent / 100) };
  }

  return { calculate: calculate, addMonths: addMonths, schedule: schedule, money: money, commission: commission, commissionRate: commissionRate };
});
