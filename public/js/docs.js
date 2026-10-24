// Печатные документы: кнопка «Распечатать» и автопечать по ссылке с ?print
(function () {
  document.querySelectorAll('[data-print]').forEach(function (b) { b.addEventListener('click', function () { window.print(); }); });
  if (new URLSearchParams(location.search).has('print')) window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 300); });
})();
