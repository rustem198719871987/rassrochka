// Страница телефона: постраничная съёмка подписанного договора
(function () {
  var MAX = 2400, LIMIT = Number(document.getElementById('pages').dataset.limit) || 30;
  var pages = [];
  var list = document.getElementById('pages');
  var input = document.getElementById('file');
  var sendBtn = document.getElementById('send');
  var err = document.getElementById('err');

  function draw(p) {
    var w = p.img.naturalWidth, h = p.img.naturalHeight;
    var k = Math.min(1, MAX / Math.max(w, h));
    w = Math.round(w * k); h = Math.round(h * k);
    var turned = p.rot % 180 !== 0;
    p.canvas.width = turned ? h : w; p.canvas.height = turned ? w : h;
    var ctx = p.canvas.getContext('2d');
    ctx.translate(p.canvas.width / 2, p.canvas.height / 2);
    ctx.rotate(p.rot * Math.PI / 180);
    ctx.drawImage(p.img, -w / 2, -h / 2, w, h);
  }

  function render() {
    list.innerHTML = '';
    pages.forEach(function (p, i) {
      var el = document.createElement('div');
      el.className = 'pg';
      el.appendChild(p.canvas);
      el.insertAdjacentHTML('beforeend', '<span class="no">стр. ' + (i + 1) + '</span><div class="row"><button type="button" data-rot>↻ Повернуть</button><button type="button" class="del" data-del>Удалить</button></div>');
      el.querySelector('[data-rot]').onclick = function () { p.rot = (p.rot + 90) % 360; draw(p); };
      el.querySelector('[data-del]').onclick = function () { pages.splice(i, 1); render(); };
      list.appendChild(el);
    });
    document.getElementById('add-label').textContent = 'Сфотографировать страницу ' + (pages.length + 1);
    document.getElementById('add').style.display = pages.length >= LIMIT ? 'none' : '';
    sendBtn.disabled = !pages.length;
    sendBtn.textContent = pages.length ? 'Отправить ' + pages.length + ' стр.' : 'Отправить';
  }

  input.addEventListener('change', function () {
    var files = Array.prototype.slice.call(input.files, 0, LIMIT - pages.length);
    files.forEach(function (f) {
      var img = new Image();
      img.onload = function () {
        var p = { img: img, rot: 0, canvas: document.createElement('canvas') };
        draw(p);
        pages.push(p);
        render();
      };
      img.src = URL.createObjectURL(f);
    });
    input.value = '';
  });

  sendBtn.addEventListener('click', async function () {
    err.style.display = 'none';
    sendBtn.disabled = true;
    sendBtn.textContent = 'Отправляем…';
    try {
      var fd = new FormData();
      for (var i = 0; i < pages.length; i++) {
        var blob = await new Promise(function (r) { pages[i].canvas.toBlob(r, 'image/jpeg', 0.88); });
        fd.append('pages', blob, 'page-' + (i + 1) + '.jpg');
      }
      var res = await fetch(location.pathname, { method: 'POST', body: fd });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Ошибка отправки');
      document.getElementById('form-view').style.display = 'none';
      document.getElementById('send-bar').style.display = 'none';
      document.getElementById('done-text').textContent = 'Загружено страниц: ' + data.pages + '. Их можно посмотреть в карточке заявки на компьютере.';
      document.getElementById('done-view').style.display = '';
    } catch (e) {
      err.textContent = e.message === 'Failed to fetch' ? 'Нет связи с сервером. Проверьте интернет и попробуйте снова.' : e.message;
      err.style.display = '';
      render();
    }
  });
  render();
})();
