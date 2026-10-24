(function () {
  // ---------- маски ввода ----------
  function maskPhone(v) {
    var d = v.replace(/\D/g, '');
    if (d[0] === '8') d = '7' + d.slice(1);
    if (d && d[0] !== '7') d = '7' + d;
    d = d.slice(0, 11);
    if (!d) return '';
    var out = '+7';
    if (d.length > 1) out += ' (' + d.slice(1, 4);
    if (d.length >= 4) out += ')';
    if (d.length > 4) out += ' ' + d.slice(4, 7);
    if (d.length > 7) out += '-' + d.slice(7, 9);
    if (d.length > 9) out += '-' + d.slice(9, 11);
    return out;
  }
  var masks = {
    phone: maskPhone,
    digits: function (v) { return v.replace(/\D/g, ''); },
    dept: function (v) {
      var d = v.replace(/\D/g, '').slice(0, 6);
      return d.length > 3 ? d.slice(0, 3) + '-' + d.slice(3) : d;
    },
  };
  document.querySelectorAll('[data-mask]').forEach(function (el) {
    var fn = masks[el.dataset.mask];
    if (!fn) return;
    if (el.value) el.value = fn(el.value);
    el.addEventListener('input', function () { el.value = fn(el.value); });
  });

  // ---------- «кем выдан» по коду подразделения (справочник на сервере) ----------
  function showIssuedOptions(by, options) {
    var field = by.closest('.field');
    var box = field.querySelector('.fms-options');
    if (box) box.remove();
    if (!options || options.length < 2) return;
    box = document.createElement('div');
    box.className = 'fms-options hint';
    box.appendChild(document.createTextNode('Варианты по коду подразделения — выберите как в паспорте: '));
    options.forEach(function (name) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'link-btn';
      b.textContent = name;
      b.addEventListener('click', function () { by.value = name; by.dispatchEvent(new Event('input', { bubbles: true })); });
      box.appendChild(b);
    });
    field.appendChild(box);
  }
  document.querySelectorAll('[name="passport_dept_code"]').forEach(function (codeEl) {
    var form = codeEl.form;
    var by = form && form.querySelector('[name="passport_issued_by"]');
    if (!by) return;
    var last = '';
    function lookup() {
      if (!/^\d{3}-\d{3}$/.test(codeEl.value) || codeEl.value === last) return;
      last = codeEl.value;
      var date = form.querySelector('[name="passport_issue_date"]');
      fetch('/api/fms?code=' + codeEl.value + '&date=' + encodeURIComponent(date ? date.value : ''))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.value) return showIssuedOptions(by, []);
          if (!by.value.trim()) {
            by.value = d.value;
            var f = by.closest('.field');
            if (f) { f.classList.remove('has-error'); f.classList.add(d.options.length > 1 ? 'uncertain' : 'autofilled'); }
          }
          showIssuedOptions(by, d.options);
        })
        .catch(function () {});
    }
    codeEl.addEventListener('input', lookup);
    if (codeEl.value) lookup();
  });

  // ---------- подтверждения, автоотправка, имя выбранного файла (вместо onsubmit/onchange в разметке) ----------
  document.addEventListener('submit', function (e) {
    var msg = e.target.getAttribute && e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  }, true);
  document.querySelectorAll('input[data-autosubmit]').forEach(function (el) {
    el.addEventListener('change', function () { if (el.form) el.form.submit(); });
  });
  document.querySelectorAll('input[data-file-label]').forEach(function (el) {
    el.addEventListener('change', function () {
      var label = el.closest('form').querySelector('[data-file-name]');
      if (label) label.textContent = el.files[0] ? el.files[0].name : 'Выберите файл выписки';
    });
  });

  // ---------- ожидание решения по проверке клиента: таймер 5 минут и автообновление ----------
  var wait = document.querySelector('[data-check-wait]');
  if (wait) {
    var deadline = Number(wait.dataset.deadline);
    var timerEl = wait.querySelector('[data-check-timer]');
    var late = document.querySelector('[data-check-late]');
    var tick = function () {
      var left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      timerEl.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
      if (!left && late) late.hidden = false;
    };
    tick();
    setInterval(tick, 1000);
    setInterval(function () {
      fetch('/app/' + wait.dataset.app + '/check-status', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d.check_status !== 'pending') location.href = '/app/' + wait.dataset.app; })
        .catch(function () {});
    }, 4000);
  }
  // очередь администратора обновляется сама, если он ничего не вводит
  var auto = document.querySelector('[data-autorefresh]');
  if (auto) {
    setInterval(function () {
      var el = document.activeElement;
      if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !el.value) location.reload();
    }, Number(auto.dataset.autorefresh) * 1000);
  }

  // ---------- кликабельные строки таблиц ----------
  document.querySelectorAll('tr[data-href]').forEach(function (tr) {
    tr.addEventListener('click', function (e) {
      if (e.target.closest('a, button, form')) return;
      location.href = tr.dataset.href;
    });
  });

  // ---------- «совпадает с адресом регистрации» ----------
  document.querySelectorAll('[data-toggle-hide]').forEach(function (cb) {
    var target = document.querySelector(cb.dataset.toggleHide);
    function sync() { if (target) target.style.display = cb.checked ? 'none' : ''; }
    cb.addEventListener('change', sync);
    sync();
  });

  // ---------- заполнение анкеты по фото паспорта (QR → телефон) ----------
  var scan = document.querySelector('[data-scan]');
  if (scan) {
    var appId = scan.dataset.app;
    var body = scan.querySelector('[data-scan-body]');
    var statusEl = scan.querySelector('[data-scan-status]');
    var notesEl = scan.querySelector('[data-scan-notes]');
    var timer = null;
    var setStatus = function (html) { statusEl.innerHTML = html; };
    var esc = function (t) { var d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

    function fill(result) {
      var form = document.getElementById('client-form');
      var uncertain = result.uncertain || [];
      var count = 0;
      Object.keys(result.fields || {}).forEach(function (name) {
        var el = form.querySelector('[name="' + name + '"]');
        if (!el) return;
        el.value = result.fields[name];
        el.dispatchEvent(new Event('input', { bubbles: true }));
        var f = el.closest('.field');
        if (f) { f.classList.remove('has-error'); f.classList.add(uncertain.indexOf(name) >= 0 ? 'uncertain' : 'autofilled'); }
        count++;
      });
      return count;
    }

    function showDocs(docs) {
      if (!docs || !docs.length) return;
      var labels = { passport_main: 'Паспорт — разворот с фото', passport_reg: 'Паспорт — прописка', client_photo: 'Фото клиента' };
      var html = docs.map(function (d) {
        return '<a class="doc-thumb" target="_blank" href="' + d.url + '"><img src="' + d.url + '?t=' + Date.now() + '" alt=""><span>' + labels[d.kind] + '</span></a>';
      }).join('');
      notesEl.insertAdjacentHTML('beforeend', '<div class="doc-thumbs" style="margin-top:14px">' + html + '</div>');
    }

    function poll(sid) {
      fetch('/app/' + appId + '/scan/' + sid, { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.status === 'waiting') return;
          if (d.status === 'processing') return setStatus('<span class="spinner"></span>Фото получены, распознаём паспорт…');
          clearInterval(timer);
          body.hidden = true;
          if (d.status === 'expired') {
            notesEl.innerHTML = '<div class="alert alert-warn" style="margin:16px 0 0">Время ожидания истекло. Нажмите «Показать QR-код» ещё раз.</div>';
            return;
          }
          if (d.status === 'error') {
            notesEl.innerHTML = '<div class="alert alert-error" style="margin:16px 0 0">' + esc(d.error || 'Ошибка распознавания') + '</div>';
            showDocs(d.docs);
            return;
          }
          var n = fill(d.result || {});
          var notes = (d.result && d.result.notes) || [];
          notesEl.innerHTML = '<div class="alert ' + (n ? 'alert-ok' : 'alert-warn') + '" style="margin:16px 0 0"><b>' +
            (n ? 'Заполнено полей: ' + n + '.' : 'Данные распознать не удалось.') + '</b> ' +
            (n ? 'Заполненные поля выделены жёлтым, сомнительные — оранжевым. Сверьте с паспортом и сохраните анкету.' : 'Заполните анкету вручную по фото.') +
            (notes.length ? '<ul style="margin:6px 0 0;padding-left:18px">' + notes.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '') +
            '</div>';
          showDocs(d.docs);
        })
        .catch(function () {});
    }

    scan.querySelector('[data-scan-start]').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      fetch('/app/' + appId + '/scan', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '_csrf=' + encodeURIComponent(scan.dataset.csrf),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          btn.disabled = false;
          btn.textContent = 'Новый QR-код';
          if (d.error) { notesEl.innerHTML = '<div class="alert alert-error" style="margin:16px 0 0">' + esc(d.error) + '</div>'; return; }
          notesEl.innerHTML = '';
          scan.querySelector('[data-scan-qr]').src = d.qr;
          scan.querySelector('[data-scan-link]').href = d.url;
          setStatus('<span class="spinner"></span>Ждём фото с телефона…');
          body.hidden = false;
          clearInterval(timer);
          timer = setInterval(function () { poll(d.id); }, 2000);
        })
        .catch(function () { btn.disabled = false; });
    });
  }

  // ---------- скан подписанного договора с телефона ----------
  var cscan = document.querySelector('[data-contract-scan]');
  if (cscan) {
    var card = cscan.closest('.card');
    var cbody = card.querySelector('[data-scan-body]');
    var cstatus = card.querySelector('[data-scan-status]');
    var ctimer = null;
    cscan.querySelector('[data-scan-start]').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      fetch('/app/' + cscan.dataset.app + '/contract-scan', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '_csrf=' + encodeURIComponent(cscan.dataset.csrf),
      }).then(function (r) { return r.json(); }).then(function (d) {
        btn.disabled = false;
        if (d.error) { cstatus.textContent = d.error; cbody.hidden = false; return; }
        card.querySelector('[data-scan-qr]').src = d.qr;
        card.querySelector('[data-scan-link]').href = d.url;
        cbody.hidden = false;
        clearInterval(ctimer);
        ctimer = setInterval(function () {
          fetch('/app/' + cscan.dataset.app + '/scan/' + d.id, { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (st) {
              if (st.status === 'done') { clearInterval(ctimer); cstatus.textContent = 'Страницы получены, обновляем…'; location.hash = 'contract-scan'; location.reload(); }
              if (st.status === 'expired') { clearInterval(ctimer); cstatus.textContent = 'Время ожидания истекло. Нажмите кнопку ещё раз.'; }
            }).catch(function () {});
        }, 2500);
      }).catch(function () { btn.disabled = false; });
    });
  }

  // ---------- модальные окна ----------
  document.querySelectorAll('[data-open-dialog]').forEach(function (btn) {
    var dlg = document.querySelector(btn.dataset.openDialog);
    if (!dlg) return;
    btn.addEventListener('click', function () {
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
      var first = dlg.querySelector('textarea, input:not([type=hidden])');
      if (first) first.focus();
    });
    dlg.querySelectorAll('[data-close-dialog]').forEach(function (c) { c.addEventListener('click', function () { dlg.close ? dlg.close() : dlg.removeAttribute('open'); }); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg && dlg.close) dlg.close(); });
  });

  // ---------- подсказка над столбцом графика ----------
  document.querySelectorAll('[data-chart]').forEach(function (wrap) {
    var tip = wrap.querySelector('.chart-tip');
    function show(g) {
      tip.textContent = '';
      var v = document.createElement('b'); v.textContent = g.dataset.value; tip.appendChild(v);
      tip.appendChild(document.createTextNode(' ' + g.dataset.label));
      if (g.dataset.extra) { var e = document.createElement('div'); e.className = 'muted'; e.textContent = g.dataset.extra; tip.appendChild(e); }
      tip.hidden = false;
      var r = g.querySelector('.bar-hit').getBoundingClientRect();
      var w = wrap.getBoundingClientRect();
      var left = r.left - w.left + r.width / 2 - tip.offsetWidth / 2;
      tip.style.left = Math.max(0, Math.min(left, w.width - tip.offsetWidth)) + 'px';
      tip.style.top = Math.max(0, Number(g.dataset.top) / Number(wrap.dataset.h) * wrap.querySelector('svg').getBoundingClientRect().height - tip.offsetHeight - 8) + 'px';
      wrap.querySelectorAll('.bar.active').forEach(function (b) { b.classList.remove('active'); });
      g.classList.add('active');
    }
    function hide() { tip.hidden = true; wrap.querySelectorAll('.bar.active').forEach(function (b) { b.classList.remove('active'); }); }
    wrap.querySelectorAll('.bar').forEach(function (g) {
      g.addEventListener('pointerenter', function () { show(g); });
      g.addEventListener('focus', function () { show(g); });
      g.addEventListener('blur', hide);
    });
    wrap.addEventListener('pointerleave', hide);
  });

  // ---------- копирование ссылки ----------
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var el = document.querySelector(btn.dataset.copy);
      var done = function () { btn.textContent = 'Скопировано'; setTimeout(function () { btn.textContent = 'Копировать'; }, 2000); };
      if (navigator.clipboard) navigator.clipboard.writeText(el.value).then(done, function () { el.select(); });
      else { el.select(); document.execCommand('copy'); done(); }
    });
  });

  // копирование готового текста (данные клиента для ручной проверки ФССП)
  document.querySelectorAll('[data-copy-text]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.dataset.copyText;
      var done = function () { btn.textContent = 'скопировано'; setTimeout(function () { btn.textContent = 'копировать'; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
    });
  });

  // ---------- живой расчёт рассрочки ----------
  var form = document.querySelector('[data-calc-form]');
  if (!form || !window.Calc) return;
  var rub = function (v) { return Math.round(Number(String(v || '').replace(/\s/g, '').replace(',', '.')) * 100) || 0; };
  var out = function (name, text) {
    form.querySelectorAll('[data-calc-out="' + name + '"]').forEach(function (el) { el.textContent = text; });
  };
  var money = Calc.money;
  var fmtDate = function (d) { return d.toLocaleDateString('ru-RU'); };

  function update() {
    var price = rub((form.querySelector('[data-calc="price"]') || {}).value);
    var down = rub((form.querySelector('[data-calc="down"]') || {}).value);
    var checked = form.querySelector('[data-calc="months"]:checked');
    var months = checked ? Number(checked.value) : 0;
    var cfg = document.getElementById('calc-config');
    var markup = Number(cfg && cfg.dataset.markup);
    var COMMISSION = cfg && cfg.dataset.commission ? JSON.parse(cfg.dataset.commission) : null;

    var table = form.querySelector('[data-calc-table]');
    if (table) {
      if (price > 0) {
        var rows = '';
        for (var m = Number(table.dataset.min); m <= Number(table.dataset.max); m++) {
          var r = Calc.calculate({ price: price, downPayment: Math.min(down, price), months: m, markupPercent: markup });
          rows += '<tr' + (m === months ? ' style="background:#fff6c2;font-weight:700"' : '') + '><td>' + m + ' мес</td><td class="num">' +
            r.markupTotalPercent + '% · ' + money(r.markup) + '</td><td class="num">' + money(r.total) + '</td><td class="num"><b>' + money(r.monthly) + '</b></td></tr>';
        }
        table.innerHTML = rows;
      } else {
        table.innerHTML = '<tr><td colspan="4" class="empty">Введите стоимость товара</td></tr>';
      }
    }

    out('months-label', months ? months + ' мес' : '');
    if (!(price > 0) || !months || down >= price) {
      ['monthly', 'price', 'markup', 'total', 'down', 'financed', 'pct', 'commission', 'rate'].forEach(function (k) { out(k, k === 'pct' || k === 'rate' ? '' : '—'); });
      var s0 = form.querySelector('[data-calc-schedule]');
      if (s0) s0.textContent = '—';
      return;
    }
    var c = Calc.calculate({ price: price, downPayment: down, months: months, markupPercent: markup });
    out('monthly', money(c.monthly));
    out('price', money(c.price));
    out('markup', money(c.markup));
    out('pct', '(' + c.markupTotalPercent + '%)');
    out('total', money(c.total));
    out('down', money(c.downPayment));
    out('financed', money(c.financed));
    if (COMMISSION) {
      var cm = Calc.commission({ months: months, price: c.price, total: c.total, rates: COMMISSION.rates, base: COMMISSION.base });
      out('commission', money(cm.amount));
      out('rate', '(' + String(cm.percent).replace('.', ',') + '%)');
    }

    var sch = form.querySelector('[data-calc-schedule]');
    if (sch) {
      sch.innerHTML = Calc.schedule(c, new Date()).map(function (p) {
        return '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #eee;color:#1d1d1f"><span>' +
          p.n + '. ' + fmtDate(p.date) + '</span><b>' + money(p.amount) + '</b></div>';
      }).join('');
    }
  }
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();
})();
