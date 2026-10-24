// Express 4 не ловит ошибки async-обработчиков: отклонённый промис оставлял запрос висеть,
// а в Node.js 22 ещё и останавливал весь сайт — так любой сбой можно было превратить в отказ в обслуживании.
// Здесь ошибка из async-обработчика передаётся обычному обработчику ошибок (страница «Что-то пошло не так»).
const Layer = require('express/lib/router/layer');

Layer.prototype.handle_request = function handle(req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return next();
  try {
    const r = fn(req, res, next);
    if (r && typeof r.catch === 'function') r.catch(next);
  } catch (err) {
    next(err);
  }
};
