const STORAGE_KEY = 'smeta-draft-v2';
const CACHE_KEY = 'smeta-data';

const els = {
  brand: document.getElementById('brand'),
  rooms: document.getElementById('rooms'),
  room: document.getElementById('room'),
  sections: document.getElementById('sections'),
  status: document.getElementById('status'),
  search: document.getElementById('search'),
  only: document.getElementById('only'),
  client: document.getElementById('client'),
  address: document.getElementById('address'),
  roomTotal: document.getElementById('roomTotal'),
  total: document.getElementById('total'),
  pdf: document.getElementById('pdf'),
  reset: document.getElementById('reset'),
  docType: document.getElementById('docType'),
};

let works = [];
let worksByCode = new Map();
let settings = {};
let logoDataUrl = null;
let state = null;

const money = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const rub = (n) => `${money.format(Math.round(n))} ₽`;
const round2 = (n) => Math.round(n * 100) / 100;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
}

// В таблице числа вбивают как «2 000», «2,3» или «2000 ₽»
function parseNumber(value) {
  const n = parseFloat(String(value ?? '').replace(/\s|₽|руб\.?/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function toWorks(rows) {
  const head = rows[0].map((h) => h.toLowerCase());
  const col = (name) => head.indexOf(name);
  const c = {
    stage: col('этап'), group: col('раздел'), section: col('подраздел'), name: col('работа'),
    unit: col('ед.'), price: col('цена'), markup: col('надбавка'), base: col('считать от'),
  };
  return rows.slice(1).flatMap((r) => {
    const name = r[c.name];
    if (!name) return [];
    const section = r[c.section] || r[c.group] || 'Работы';
    // «Черновые, Лицевые» — раздел показывается на обеих вкладках
    const stage = r[c.stage] || 'Работы';
    return [{
      // Кодов в таблице нет: Денис правит её сам, работу узнаём по этапу, разделу и названию
      code: `${stage}|${section}|${name}`,
      stage,
      stages: stage.split(',').map((x) => x.trim()).filter(Boolean),
      section,
      name,
      unit: r[c.unit] || 'шт.',
      basePrice: parseNumber(r[c.price]),
      markup: (r[c.markup] || 'да').toLowerCase() !== 'нет',
      base: (r[c.base] || 'замер').toLowerCase(),
    }];
  });
}

function toSettings(rows) {
  return Object.fromEntries(rows.slice(1).map(([key, value]) => [key.toLowerCase(), value || '']));
}

function unitPrice(work) {
  const k = work.markup ? parseNumber(settings['коэффициент надбавки']) || 1 : 1;
  const vat = parseNumber(settings['ндс']) || 1;
  return Math.round(work.basePrice * k * vat);
}

// Те же формулы, что в листах комнат шаблона: стены за вычетом окон и дверей, плинтус без ширины дверей
function measure(room) {
  const L = parseNumber(room.length);
  const W = parseNumber(room.width);
  const H = parseNumber(room.height);
  const windows = room.windows.map((o) => ({ w: parseNumber(o.w), h: parseNumber(o.h) }));
  const doors = room.doors.map((o) => ({ w: parseNumber(o.w), h: parseNumber(o.h) }));
  const perimeter = 2 * (L + W);
  const windowsArea = windows.reduce((s, o) => s + o.w * o.h, 0);
  const openings = windowsArea + doors.reduce((s, o) => s + o.w * o.h, 0);
  const floor = round2(L * W);
  const walls = round2(Math.max(perimeter * H - openings, 0));
  return {
    'пол': floor,
    'потолок': floor,
    'стены': walls,
    'стены+потолок': round2(walls + floor),
    'периметр': round2(perimeter),
    'плинтус': round2(Math.max(perimeter - doors.reduce((s, o) => s + o.w, 0), 0)),
    'откосы': round2(windows.reduce((s, o) => s + o.w + 2 * o.h, 0)),
    'проёмы': round2(openings),
    'окна': round2(windowsArea),
    'ширина окон': round2(windows.reduce((s, o) => s + o.w, 0)),
    'высота': H,
  };
}

// «стены*0.5» — доля замера, «2» — количество по умолчанию, «замер» — вводится руками
function autoQty(work, m) {
  const [key, factor] = work.base.split('*');
  if (key in m) return round2(m[key] * (factor ? parseNumber(factor) : 1));
  const n = parseNumber(work.base);
  return n > 0 ? n : '';
}

function newRoom(name) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name, length: '', width: '', height: settings['высота'] || '2,7',
    windows: [], doors: [], picked: {},
  };
}

function current() {
  return state.rooms.find((r) => r.id === state.current) || state.rooms[0];
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

const docType = () => state.docType || 'Смета';

function renderDocType() {
  els.docType.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.textContent === docType()));
}

function restore() {
  state = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  if (!state?.rooms?.length) {
    state = { client: '', address: '', rooms: [newRoom('Комната 1')] };
    state.current = state.rooms[0].id;
  }
  els.client.value = state.client;
  els.address.value = state.address;
  renderDocType();
}

// Пересчитать автоматические объёмы после смены размеров; правленные руками не трогаем
function syncQty(room) {
  const m = measure(room);
  Object.entries(room.picked).forEach(([code, p]) => {
    const work = worksByCode.get(code);
    if (work && !p.manual) p.qty = String(autoQty(work, m)).replace('.', ',');
  });
}

const CUSTOM = 'Дополнительные работы';

function roomLines(room) {
  return Object.entries(room.picked).flatMap(([code, p]) => {
    const work = worksByCode.get(code);
    if (!work) return [];
    const qty = parseNumber(p.qty);
    const price = unitPrice(work);
    return [{ ...work, qty, price, sum: qty * price }];
  }).concat((room.custom || []).filter((c) => c.name || c.sum).map((c, i) => {
    // Нестандартная работа с объекта: только название и сумма, в прайс не попадает
    const price = parseNumber(c.sum);
    return {
      code: `custom-${i}`, stage: CUSTOM, stages: [CUSTOM], section: CUSTOM,
      name: c.name || 'Работа', unit: 'усл.', qty: 1, price, sum: price,
    };
  }));
}

const roomSum = (room) => roomLines(room).reduce((s, l) => s + l.sum, 0);

function updateTotals() {
  const room = current();
  if (pendingFile) {
    pendingFile = null;
    els.pdf.textContent = 'Скачать PDF';
  }
  els.roomTotal.textContent = `${room.name || 'Комната'}: ${rub(roomSum(room))}`;
  els.total.textContent = rub(state.rooms.reduce((s, r) => s + roomSum(r), 0));
  if (els.sections.firstChild) updateCounts();
  els.pdf.disabled = !state.rooms.some((r) => roomLines(r).some((l) => l.qty > 0));
  els.rooms.querySelectorAll('[data-room]').forEach((btn) => {
    const r = state.rooms.find((x) => x.id === btn.dataset.room);
    btn.querySelector('small').textContent = rub(roomSum(r));
  });
}

function renderRooms() {
  els.rooms.innerHTML = '';
  state.rooms.forEach((r) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.room = r.id;
    btn.className = r.id === current().id ? 'chip active' : 'chip';
    btn.innerHTML = '<span></span><small></small>';
    btn.querySelector('span').textContent = r.name || 'Без названия';
    btn.addEventListener('click', () => {
      state.current = r.id;
      save();
      renderAll();
    });
    els.rooms.appendChild(btn);
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'chip add';
  add.textContent = '+ Комната';
  add.addEventListener('click', () => {
    const room = newRoom(`Комната ${state.rooms.length + 1}`);
    state.rooms.push(room);
    state.current = room.id;
    save();
    renderAll();
    els.room.querySelector('[data-field=name]').select();
  });
  els.rooms.appendChild(add);
}

function openingRows(room, kind, title) {
  return room[kind].map((o, i) => `
    <div class="opening" data-kind="${kind}" data-index="${i}">
      <span>${title} ${i + 1}</span>
      <input type="text" inputmode="decimal" data-dim="w" placeholder="ширина">
      <span>×</span>
      <input type="text" inputmode="decimal" data-dim="h" placeholder="высота">
      <button type="button" class="del" aria-label="Удалить">×</button>
    </div>`).join('');
}

function renderRoom() {
  const room = current();
  const m = measure(room);
  els.room.innerHTML = `
    <div class="room-head">
      <input type="text" data-field="name" class="room-name" placeholder="Название комнаты">
      <button type="button" class="link" data-act="copy">Копировать</button>
      ${state.rooms.length > 1 ? '<button type="button" class="link danger" data-act="remove">Удалить</button>' : ''}
    </div>
    <div class="dims">
      <label>Длина, м<input type="text" inputmode="decimal" data-field="length"></label>
      <label>Ширина, м<input type="text" inputmode="decimal" data-field="width"></label>
      <label>Высота, м<input type="text" inputmode="decimal" data-field="height"></label>
    </div>
    ${openingRows(room, 'windows', 'Окно')}
    ${openingRows(room, 'doors', 'Дверь')}
    <div class="add-openings">
      <button type="button" class="link" data-act="windows">+ окно</button>
      <button type="button" class="link" data-act="doors">+ дверь</button>
    </div>
    <div class="measures">
      Пол ${money.format(m['пол'])} м² · Стены ${money.format(m['стены'])} м² ·
      Периметр ${money.format(m['периметр'])} м · Откосы ${money.format(m['откосы'])} м
    </div>
    ${(room.custom || []).map((c, i) => `
    <div class="custom" data-index="${i}">
      <input type="text" data-custom="name" placeholder="Своя работа">
      <input type="text" inputmode="decimal" data-custom="sum" placeholder="Сумма, ₽">
      <button type="button" class="del" aria-label="Удалить">×</button>
    </div>`).join('')}
    <div class="add-openings">
      <button type="button" class="link" data-act="custom">+ своя работа</button>
    </div>`;

  els.room.querySelectorAll('.custom').forEach((row) => {
    const item = room.custom[row.dataset.index];
    row.querySelectorAll('[data-custom]').forEach((input) => {
      input.value = item[input.dataset.custom];
      input.addEventListener('input', () => {
        item[input.dataset.custom] = input.value;
        updateTotals();
        save();
      });
    });
    row.querySelector('.del').addEventListener('click', () => {
      room.custom.splice(row.dataset.index, 1);
      updateTotals();
      save();
      renderRoom();
    });
  });

  els.room.querySelectorAll('[data-field]').forEach((input) => {
    input.value = room[input.dataset.field];
    input.addEventListener('input', () => {
      room[input.dataset.field] = input.value;
      if (input.dataset.field === 'name') {
        els.rooms.querySelector(`[data-room="${room.id}"] span`).textContent = input.value || 'Без названия';
      } else {
        onDimsChange(room);
      }
      updateTotals();
      save();
    });
  });

  els.room.querySelectorAll('.opening').forEach((row) => {
    const item = room[row.dataset.kind][row.dataset.index];
    row.querySelectorAll('[data-dim]').forEach((input) => {
      input.value = item[input.dataset.dim];
      input.addEventListener('input', () => {
        item[input.dataset.dim] = input.value;
        onDimsChange(room);
        save();
      });
    });
    row.querySelector('.del').addEventListener('click', () => {
      room[row.dataset.kind].splice(row.dataset.index, 1);
      onDimsChange(room);
      save();
      renderRoom();
    });
  });

  els.room.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', () => {
    const act = btn.dataset.act;
    if (act === 'remove') {
      if (!confirm(`Удалить «${room.name}» вместе с работами?`)) return;
      state.rooms = state.rooms.filter((r) => r.id !== room.id);
      state.current = state.rooms[0].id;
      save();
      renderAll();
      return;
    }
    if (act === 'copy') {
      // Похожая комната — размеры, проёмы и отмеченные работы те же, правится только отличие
      const copy = { ...JSON.parse(JSON.stringify(room)), id: newRoom('').id, name: `${room.name} (копия)` };
      state.rooms.splice(state.rooms.indexOf(room) + 1, 0, copy);
      state.current = copy.id;
      save();
      renderAll();
      return;
    }
    if (act === 'custom') {
      (room.custom ||= []).push({ name: '', sum: '' });
      save();
      renderRoom();
      [...els.room.querySelectorAll('[data-custom=name]')].pop().focus();
      return;
    }
    room[act].push(act === 'doors' ? { w: '0,8', h: '2,1' } : { w: '', h: '' });
    save();
    renderRoom();
  }));
}

function onDimsChange(room) {
  syncQty(room);
  const m = measure(room);
  els.room.querySelector('.measures').textContent =
    `Пол ${money.format(m['пол'])} м² · Стены ${money.format(m['стены'])} м² · ` +
    `Периметр ${money.format(m['периметр'])} м · Откосы ${money.format(m['откосы'])} м`;
  els.sections.querySelectorAll('.work.on').forEach((row) => {
    row.querySelector('.qty input').value = room.picked[row.dataset.code]?.qty ?? '';
    row.refreshSum();
  });
  updateTotals();
}

function renderRow(work, room) {
  const row = document.createElement('div');
  row.className = 'work';
  row.dataset.code = work.code;
  row.dataset.name = searchable(work.name);
  const price = unitPrice(work);
  const on = () => Boolean(room.picked[work.code]);
  row.innerHTML = `
    <label class="pick">
      <input type="checkbox">
      <span class="name"></span>
      <span class="price">${rub(price)} / ${work.unit}${work.base === 'замер' ? ' · замер' : ''}</span>
    </label>
    <div class="qty">
      <input type="text" inputmode="decimal" placeholder="0">
      <span class="unit"></span>
      <span class="sum"></span>
    </div>`;
  row.querySelector('.name').textContent = work.name;
  row.querySelector('.unit').textContent = work.unit;

  const box = row.querySelector('input[type=checkbox]');
  const qty = row.querySelector('.qty input');
  const sum = row.querySelector('.sum');
  row.refreshSum = () => {
    sum.textContent = on() ? `= ${rub(parseNumber(room.picked[work.code].qty) * price)}` : '';
  };
  row.sync = () => {
    box.checked = on();
    row.classList.toggle('on', on());
    qty.value = room.picked[work.code]?.qty ?? '';
    row.refreshSum();
  };
  row.sync();

  // Разделы «Этап II и III» стоят в двух группах, вторую копию строки держим в том же состоянии
  const syncTwins = () => {
    els.sections.querySelectorAll('.work').forEach((other) => {
      if (other !== row && other.dataset.code === work.code) other.sync();
    });
  };

  box.addEventListener('change', () => {
    if (box.checked) {
      room.picked[work.code] = { qty: String(autoQty(work, measure(room))).replace('.', ','), manual: false };
    } else {
      delete room.picked[work.code];
    }
    row.sync();
    if (box.checked && !qty.value) qty.focus();
    syncTwins();
    updateTotals();
    save();
  });

  qty.addEventListener('input', () => {
    room.picked[work.code] = { qty: qty.value, manual: true };
    row.refreshSum();
    syncTwins();
    updateTotals();
    save();
  });

  return row;
}

// В прайсе то «шпаклевка», то «шпаклёвка» — ищем без разницы
const searchable = (text) => text.toLowerCase().replace(/ё/g, 'е');

// «Черновые» → «Черновые работы», а «Откосы» так и остаются
const stageTitle = (stage) => (/(ые|ие)$/.test(stage) ? `${stage} работы` : stage);

function stageList() {
  return [...new Set(works.flatMap((w) => w.stages))];
}

function sectionBlock(list, primary) {
  const room = current();
  const block = document.createElement('details');
  block.className = 'section';
  block.list = list;
  block.primary = primary;
  block.open = list.some((w) => room.picked[w.code]);
  block.innerHTML = '<summary><span></span><small></small></summary>';
  block.querySelector('summary span').textContent = list[0].section;
  // Строки рисуем при первом раскрытии, иначе тысяча строк тормозит на телефоне
  block.fill = () => {
    if (block.dataset.filled) return;
    block.dataset.filled = '1';
    list.forEach((w) => block.appendChild(renderRow(w, room)));
    applyFilter();
  };
  if (block.open) block.fill();
  block.addEventListener('toggle', () => block.open && block.fill());
  return block;
}

function renderWorks() {
  const room = current();
  els.sections.innerHTML = '';
  const bySection = new Map();
  works.forEach((w) => {
    const key = `${w.stage}|${w.section}`;
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(w);
  });

  // Виды работ → разделы внутри: «Демонтажные работы» → пол, стены…
  stageList().forEach((stage) => {
    const group = document.createElement('details');
    group.className = 'stage-group';
    group.innerHTML = '<summary><span></span><small></small></summary>';
    group.querySelector('summary span').textContent = stageTitle(stage);
    bySection.forEach((list) => {
      if (list[0].stages.includes(stage)) group.appendChild(sectionBlock(list, list[0].stages[0] === stage));
    });
    // Группа из одного раздела («Электромонтажные работы») — без лишнего уровня, сразу работы
    const only = group.querySelectorAll('.section');
    if (only.length === 1) {
      only[0].classList.add('solo');
      only[0].open = true;
      only[0].fill();
    }
    group.open = [...group.querySelectorAll('.section')].some((b) => b.open && !b.classList.contains('solo'))
      || [...group.querySelectorAll('.section')].some((b) => b.list.some((w) => room.picked[w.code]));
    els.sections.appendChild(group);
  });
  updateCounts();
  applyFilter();
}

function updateCounts() {
  const room = current();
  els.sections.querySelectorAll('.section').forEach((block) => {
    const picked = block.list.filter((w) => room.picked[w.code]).length;
    block.querySelector('summary small').textContent = picked ? `выбрано ${picked}` : block.list.length;
  });
  els.sections.querySelectorAll('.stage-group').forEach((group) => {
    const codes = new Set();
    group.querySelectorAll('.section').forEach((b) => b.list.forEach((w) => room.picked[w.code] && codes.add(w.code)));
    group.querySelector(':scope > summary small').textContent = codes.size ? `выбрано ${codes.size}` : '';
  });
}

function applyFilter() {
  const q = searchable(els.search.value.trim());
  const only = els.only.checked;
  const filtering = Boolean(q || only);
  const room = current();
  els.sections.querySelectorAll('.stage-group').forEach((group) => {
    let groupVisible = 0;
    group.querySelectorAll('.section').forEach((block) => {
      // При поиске раздел из двух групп показываем один раз
      if (filtering && !block.primary) {
        block.hidden = true;
        return;
      }
      if (filtering && !block.dataset.filled) block.fill();
      let visible = 0;
      block.querySelectorAll('.work').forEach((row) => {
        const hit = (!q || row.dataset.name.includes(q)) && (!only || room.picked[row.dataset.code]);
        row.hidden = !hit;
        if (hit) visible++;
      });
      block.hidden = filtering && !visible;
      if (filtering && visible) block.open = true;
      if (!block.hidden) groupVisible++;
    });
    group.hidden = filtering && !groupVisible;
    if (filtering && groupVisible) group.open = true;
  });
}

function renderAll() {
  renderRooms();
  renderRoom();
  renderWorks();
  updateTotals();
}

function buildPdf() {
  const date = new Date().toLocaleDateString('ru-RU');
  const contacts = [settings['телефон'], settings['email'], settings['адрес']].filter(Boolean).join('   ');
  const company = { stack: [
    { text: settings['название'] || '', style: 'company' },
    { text: contacts, color: '#555' },
  ] };
  const meta = [
    els.client.value && `Клиент: ${els.client.value}`,
    els.address.value && `Объект: ${els.address.value}`,
  ].filter(Boolean);

  const content = [
    logoDataUrl
      ? { columns: [{ image: logoDataUrl, fit: [90, 50], width: 100 }, company], columnGap: 12 }
      : company,
    { text: `${docType()} от ${date}`, style: 'title' },
    ...meta.map((text) => ({ text, margin: [0, 0, 0, 2] })),
  ];
  const summary = [];
  let total = 0;

  state.rooms.forEach((room) => {
    const lines = roomLines(room).filter((l) => l.qty > 0);
    if (!lines.length) return;
    const m = measure(room);
    const sum = lines.reduce((s, l) => s + l.sum, 0);
    total += sum;
    summary.push([room.name, { text: rub(sum), alignment: 'right' }]);

    const head = ['№', 'Работа', 'Кол-во', 'Ед.', 'Цена', 'Сумма'].map((text, i) => ({
      text, style: 'th', alignment: [2, 4, 5].includes(i) ? 'right' : 'left',
    }));
    const body = [head];
    let n = 0;
    let section = null;
    // Строки идут в порядке прайса, как в шаблоне, а не в порядке нажатия галочек
    const order = (l) => (worksByCode.has(l.code) ? works.indexOf(worksByCode.get(l.code)) : Infinity);
    lines.sort((a, b) => order(a) - order(b));
    lines.forEach((l) => {
      if (`${l.stage}|${l.section}` !== section) {
        section = `${l.stage}|${l.section}`;
        const title = l.stages.map(stageTitle).join(', ');
        body.push([{ text: title === l.section ? title : `${title} · ${l.section}`, colSpan: 6, style: 'sec' }, {}, {}, {}, {}, {}]);
      }
      body.push([
        String(++n), l.name,
        { text: money.format(l.qty), alignment: 'right' }, l.unit,
        { text: rub(l.price), alignment: 'right' },
        { text: rub(l.sum), alignment: 'right' },
      ]);
    });

    content.push(
      { text: room.name, style: 'room' },
      m['пол'] ? { text: `Пол ${money.format(m['пол'])} м², стены ${money.format(m['стены'])} м², периметр ${money.format(m['периметр'])} м`, color: '#555' } : '',
      {
        margin: [0, 6, 0, 0],
        table: { headerRows: 1, widths: [18, '*', 42, 38, 58, 66], body },
        layout: { hLineColor: '#ccc', vLineColor: '#ccc', fillColor: (i) => (i === 0 ? '#1f3a5f' : null) },
      },
      { text: `Итого по помещению: ${rub(sum)}`, style: 'subtotal' },
    );
  });

  if (summary.length > 1) {
    content.push(
      { text: 'Сводная по помещениям', style: 'room' },
      { table: { widths: ['*', 90], body: summary }, layout: 'lightHorizontalLines', margin: [0, 6, 0, 0] },
    );
  }
  content.push({ text: `Итого: ${rub(total)}`, style: 'total' });
  // «Смета предварительная…» в акте выполненных работ неуместна
  if (settings['примечание'] && docType() === 'Смета') content.push({ text: settings['примечание'], color: '#555', margin: [0, 12, 0, 0] });

  const doc = {
    pageSize: 'A4',
    pageMargins: [36, 36, 36, 40],
    defaultStyle: { font: 'Roboto', fontSize: 9.5 },
    footer: (page, pages) => ({ text: `${page} / ${pages}`, alignment: 'right', margin: [0, 10, 36, 0], fontSize: 8, color: '#888' }),
    content,
    styles: {
      company: { fontSize: 14, bold: true },
      title: { fontSize: 16, bold: true, margin: [0, 18, 0, 8] },
      room: { fontSize: 13, bold: true, margin: [0, 16, 0, 2] },
      th: { bold: true, color: '#fff' },
      sec: { bold: true, fillColor: '#eef2f7' },
      subtotal: { bold: true, alignment: 'right', margin: [0, 6, 0, 0] },
      total: { fontSize: 13, bold: true, alignment: 'right', margin: [0, 14, 0, 0] },
    },
  };

  const name = [docType(), els.client.value, date].filter(Boolean).join(' ').replace(/[\\/:*?"<>|]/g, '');
  return { pdf: window.pdfMake.createPdf(doc), name: `${name}.pdf` };
}

// Готовый файл ждёт второго нажатия, если телефон не дал поделиться сразу
let pendingFile = null;

async function sharePdf(file) {
  try {
    // Без title: iPhone иначе сохраняет и отправляет название отдельным текстовым файлом
    await navigator.share({ files: [file] });
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }
}

async function onPdfClick() {
  if (pendingFile) {
    const file = pendingFile;
    pendingFile = null;
    els.pdf.textContent = 'Скачать PDF';
    await sharePdf(file);
    return;
  }

  const { pdf, name } = buildPdf();
  // На телефоне скачивание через ссылку ломается: iPhone сохраняет файл без типа, а ссылка
  // на blob никуда не ведёт. Отдаём файл через «Поделиться» — оттуда в Файлы, WhatsApp, Telegram
  const mobile = matchMedia('(pointer: coarse)').matches;
  if (!mobile || !navigator.canShare) {
    pdf.download(name);
    return;
  }
  const file = new File([await pdf.getBlob()], name, { type: 'application/pdf' });
  if (!navigator.canShare({ files: [file] })) {
    pdf.open();
    return;
  }
  try {
    await sharePdf(file);
  } catch (err) {
    // Пока собирался PDF, Safari успел «забыть» нажатие — просим нажать ещё раз
    if (err.name !== 'NotAllowedError') throw err;
    pendingFile = file;
    els.pdf.textContent = 'Отправить PDF';
  }
}

async function fetchText(url) {
  const sep = url.includes('?') ? '&' : '?';
  // Без таймаута медленный ответ Google на объекте подвешивает загрузку на минуту
  // AbortSignal.timeout нет на iPhone с iOS 15 — там просто ждём ответа
  const signal = AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;
  const res = await fetch(`${url}${sep}t=${Date.now()}`, { cache: 'no-store', signal });
  if (!res.ok) throw new Error(res.status);
  return res.text();
}

async function fetchPair(pricesUrl, settingsUrl) {
  const [prices, conf] = await Promise.all([fetchText(pricesUrl), fetchText(settingsUrl)]);
  // Снятая с публикации таблица отдаёт страницу входа с кодом 200
  if (!/работа/i.test(prices.split('\n')[0])) throw new Error('not a price list');
  return { prices, conf };
}

async function loadData() {
  const { pricesUrl, settingsUrl, backupPricesUrl, backupSettingsUrl } = window.SMETA_CONFIG;
  try {
    const data = await fetchPair(pricesUrl, settingsUrl);
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...data, at: Date.now() }));
    return { ...data, fresh: true };
  } catch {
    // На объекте связь бывает плохая: работаем по последнему загруженному прайсу,
    // а если его ещё нет — по копии на нашем сервере
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (cached) return { ...cached, fresh: false };
    return { ...(await fetchPair(backupPricesUrl, backupSettingsUrl)), fresh: false };
  }
}

async function loadLogo(url) {
  if (!url) return null;
  try {
    const blob = await (await fetch(url)).blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function init() {
  els.status.textContent = 'Загружаю прайс…';
  try {
    const { prices, conf, fresh } = await loadData();
    works = toWorks(parseCsv(prices));
    worksByCode = new Map(works.map((w) => [w.code, w]));
    settings = toSettings(parseCsv(conf));
    els.status.textContent = fresh ? '' : 'Нет связи — прайс из последней загрузки';
  } catch {
    els.status.textContent = 'Не удалось загрузить прайс. Проверьте интернет и обновите страницу.';
    return;
  }

  if (settings['название']) {
    els.brand.textContent = settings['название'];
    document.title = `Смета — ${settings['название']}`;
  }
  restore();
  // Работы, которых больше нет в прайсе, из черновика убираем
  state.rooms.forEach((r) => Object.keys(r.picked).forEach((code) => {
    if (!worksByCode.has(code)) delete r.picked[code];
  }));
  renderAll();
  logoDataUrl = await loadLogo(settings['логотип']);
}

els.search.addEventListener('input', applyFilter);
els.only.addEventListener('change', applyFilter);
els.client.addEventListener('input', () => { state.client = els.client.value; save(); });
els.address.addEventListener('input', () => { state.address = els.address.value; save(); });
els.docType.addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') return;
  state.docType = e.target.textContent;
  save();
  renderDocType();
});
els.pdf.addEventListener('click', onPdfClick);
els.reset.addEventListener('click', () => {
  if (!confirm('Начать новую смету? Текущая очистится.')) return;
  localStorage.removeItem(STORAGE_KEY);
  restore();
  els.search.value = '';
  els.only.checked = false;
  renderAll();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

init();
