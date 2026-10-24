// Страница телефона: фото паспорта и клиента (сжатие, поворот, отправка)
(function () {
  var MAX = 2200;
  var state = {};
  var sendBtn = document.getElementById('send');
  var err = document.getElementById('err');

  function draw(kind) {
    var st = state[kind];
    var c = document.querySelector('[data-slot="' + kind + '"] canvas');
    var w = st.img.naturalWidth, h = st.img.naturalHeight;
    var k = Math.min(1, MAX / Math.max(w, h));
    w = Math.round(w * k); h = Math.round(h * k);
    var turned = st.rot % 180 !== 0;
    c.width = turned ? h : w; c.height = turned ? w : h;
    var ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(st.rot * Math.PI / 180);
    ctx.drawImage(st.img, -w / 2, -h / 2, w, h);
  }

  function refresh() {
    sendBtn.disabled = !state.passport_main;
  }

  document.querySelectorAll('[data-slot]').forEach(function (slot) {
    var kind = slot.dataset.slot;
    var input = slot.querySelector('input[type=file]');
    input.addEventListener('change', function () {
      var f = input.files[0];
      if (!f) return;
      var img = new Image();
      img.onload = function () {
        state[kind] = { img: img, rot: 0 };
        slot.classList.add('filled');
        draw(kind);
        refresh();
      };
      img.onerror = function () { alert('Не удалось открыть фото. Попробуйте ещё раз.'); };
      img.src = URL.createObjectURL(f);
    });
    slot.querySelector('[data-act=rotate]').addEventListener('click', function () {
      state[kind].rot = (state[kind].rot + 90) % 360;
      draw(kind);
    });
    slot.querySelector('[data-act=retake]').addEventListener('click', function () {
      delete state[kind];
      slot.classList.remove('filled');
      input.value = '';
      input.click();
      refresh();
    });
  });

  function toBlob(canvas) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.88); });
  }

  sendBtn.addEventListener('click', async function () {
    err.style.display = 'none';
    sendBtn.disabled = true;
    sendBtn.textContent = 'Отправляем…';
    try {
      var fd = new FormData();
      for (var kind in state) {
        var blob = await toBlob(document.querySelector('[data-slot="' + kind + '"] canvas'));
        fd.append(kind, blob, kind + '.jpg');
      }
      var res = await fetch(location.pathname, { method: 'POST', body: fd });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Ошибка отправки');
      document.getElementById('form-view').style.display = 'none';
      document.getElementById('send-bar').style.display = 'none';
      document.getElementById('done-view').style.display = '';
    } catch (e) {
      err.textContent = e.message === 'Failed to fetch' ? 'Нет связи с сервером. Проверьте интернет и попробуйте снова.' : e.message;
      err.style.display = '';
      sendBtn.disabled = false;
      sendBtn.textContent = 'Отправить';
    }
  });
})();
