/* Страница настроек OpenRGB ↔ Discord MicSync (без фреймворков) */

const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  devices: [],
  deviceInfoById: new Map(),
  discord: null,
  openrgb: null
};

/* ---------- утилиты ---------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(message, ok = true) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${ok ? 'ok' : 'bad'}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

function rgbToHex(c) {
  if (!c) return '#ffffff';
  const h = (v) => Number(v).toString(16).padStart(2, '0');
  return `#${h(c.red)}${h(c.green)}${h(c.blue)}`;
}

function hexToRgb(hex) {
  const clean = String(hex).replace('#', '');
  return {
    red: parseInt(clean.slice(0, 2), 16),
    green: parseInt(clean.slice(2, 4), 16),
    blue: parseInt(clean.slice(4, 6), 16)
  };
}

/* ---------- статус ---------- */

async function refreshStatus() {
  try {
    const data = await api('/api/status');
    state.settings = data.settings;
    state.discord = data.discord;
    state.openrgb = data.openrgb;
    renderStatus(data);
    if (!$('device-select').dataset.filled) {
      fillForm(data.settings);
    }
    $('autostart').checked = !!data.autostart.enabled;
  } catch (e) {
    setBadge('badge-discord', 'Приложение недоступно', 'bad');
  }
}

function setBadge(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = `badge ${cls === 'ok' ? 'badge-ok' : cls === 'bad' ? 'badge-bad' : 'badge-muted'}`;
}

function renderStatus(data) {
  const d = data.discord;
  setBadge('badge-discord',
    d.connected ? 'Discord: подключён' : `Discord: нет (${d.lastError || 'ждём подключение'})`,
    d.connected ? 'ok' : 'bad');

  setBadge('badge-openrgb',
    data.openrgb.connected ? `OpenRGB: ${data.openrgb.host}:${data.openrgb.port}` : 'OpenRGB: не подключён',
    data.openrgb.connected ? 'ok' : 'bad');

  if (d.connected && d.micMuted !== null) {
    /* OFF (выключено) — красный, ON (активно) — зелёный */
    setBadge('badge-mic', d.micMuted ? 'Микрофон: OFF' : 'Микрофон: ON', d.micMuted ? 'bad' : 'ok');
    setBadge('badge-sound', d.deaf ? 'Звук: OFF' : 'Звук: ON', d.deaf ? 'bad' : 'ok');
  } else {
    setBadge('badge-mic', 'Микрофон: …', '');
    setBadge('badge-sound', 'Звук: …', '');
  }

  /* Состояние тумблера подсветки (может меняться только со страницы,
     но поле в форме может быть открыто заново — синхронизируем) */
  renderHighlightBtn(data.openrgb.highlight && data.openrgb.highlight.enabled);

  if (data.openrgb.device) {
    state.deviceInfoById.set(data.openrgb.device.id, data.openrgb.device);
    updateLedHint();
  }

  /* Как только OpenRGB подключился — один раз грузим список устройств */
  if (data.openrgb.connected && !$('device-select').dataset.filled) {
    loadDevices();
  }
}

/* ---------- форма ---------- */

function fillForm(s) {
  $('mic-index').value = s.device.micLedIndex;
  $('sound-index').value = s.device.soundLedIndex;
  $('mic-muted-color').value = rgbToHex(s.colors.micMuted);
  $('mic-unmuted-color').value = rgbToHex(s.colors.micUnmuted);
  $('sound-deaf-color').value = rgbToHex(s.colors.soundDeaf);
  $('sound-undeaf-color').value = rgbToHex(s.colors.soundUndeaf);
  $('webui-port').value = s.webui.port;
  $('openrgb-host').value = s.openrgb.host;
  $('openrgb-port').value = s.openrgb.port;
  $('open-on-start').checked = !!s.webui.openOnStart;
  updateDeviceSelect(s.device.keyboardDeviceId);
}

async function loadDevices() {
  const btn = $('btn-devices');
  btn.disabled = true;
  $('device-hint').textContent = 'Загружаю устройства…';
  $('device-hint').className = 'hint';

  try {
    const data = await api('/api/devices');
    state.devices = data.devices;
    for (const dev of data.devices) state.deviceInfoById.set(dev.id, dev);

    const currentId = state.settings ? state.settings.device.keyboardDeviceId : null;
    updateDeviceSelect(currentId);
    $('device-select').dataset.filled = '1';
    $('device-hint').textContent = `Загружено устройств: ${data.devices.length}`;
  } catch (e) {
    $('device-hint').textContent = `Не удалось получить устройства: ${e.message}`;
    $('device-hint').className = 'hint error';
  } finally {
    btn.disabled = false;
  }
}

function updateDeviceSelect(selectedId) {
  const select = $('device-select');
  if (!state.devices.length) {
    select.innerHTML = '<option>устройства не загружены — нажмите «Обновить список»</option>';
    return;
  }
  select.innerHTML = '';
  for (const dev of state.devices) {
    const opt = document.createElement('option');
    opt.value = dev.id;
    opt.textContent = `id ${dev.id} · ${dev.name} · ${dev.ledCount} LED`;
    if (String(dev.id) === String(selectedId)) opt.selected = true;
    select.appendChild(opt);
  }
}

function updateLedHint() {
  const hint = $('led-hint');
  const devId = parseInt($('device-select').value, 10);
  const info = state.deviceInfoById.get(devId);

  if (!Number.isInteger(devId)) {
    hint.textContent = 'Выберите устройство, чтобы увидеть число LED.';
    hint.className = 'hint';
    return;
  }
  if (!info) {
    hint.textContent = 'Нажмите «Обновить список», чтобы узнать число LED у устройства.';
    hint.className = 'hint';
    return;
  }

  const mic = parseInt($('mic-index').value, 10);
  const sound = parseInt($('sound-index').value, 10);
  const problems = [];
  if (Number.isInteger(mic) && mic >= info.ledCount) problems.push(`индекс микрофона ${mic} ≥ ${info.ledCount}`);
  if (Number.isInteger(sound) && sound >= info.ledCount) problems.push(`индекс звука ${sound} ≥ ${info.ledCount}`);

  if (problems.length) {
    hint.textContent = `«${info.name}»: ${info.ledCount} LED — ${problems.join(', ')}! Индексы за пределами устройства будут пропущены.`;
    hint.className = 'hint error';
  } else {
    hint.textContent = `«${info.name}»: ${info.ledCount} LED — индексы в допустимом диапазоне.`;
    hint.className = 'hint';
  }
}

function collectSettings() {
  return {
    device: {
      keyboardDeviceId: parseInt($('device-select').value, 10),
      micLedIndex: parseInt($('mic-index').value, 10),
      soundLedIndex: parseInt($('sound-index').value, 10)
    },
    colors: {
      micMuted: hexToRgb($('mic-muted-color').value),
      micUnmuted: hexToRgb($('mic-unmuted-color').value),
      soundDeaf: hexToRgb($('sound-deaf-color').value),
      soundUndeaf: hexToRgb($('sound-undeaf-color').value)
    },
    openrgb: {
      host: $('openrgb-host').value.trim(),
      port: parseInt($('openrgb-port').value, 10)
    },
    webui: {
      port: parseInt($('webui-port').value, 10),
      openOnStart: $('open-on-start').checked
    }
  };
}

async function save() {
  const status = $('save-status');
  status.textContent = 'Сохраняю…';
  status.className = 'hint';

  try {
    const data = await api('/api/settings', { method: 'POST', body: JSON.stringify(collectSettings()) });
    state.settings = data.settings;
    status.textContent = 'Сохранено и применено.';
    toast('Настройки сохранены и применены.');
    updateLedHint();
    await loadDevices();
  } catch (e) {
    status.textContent = `Ошибка: ${e.message}`;
    status.className = 'hint error';
    toast(`Ошибка сохранения: ${e.message}`, false);
  }
}

/* ---------- подсветка LED (тумблер 💡) ---------- */

let highlightOn = false;

function renderHighlightBtn(enabled) {
  highlightOn = !!enabled;
  const btn = $('btn-highlight');
  btn.classList.toggle('active', highlightOn);
  btn.setAttribute('aria-pressed', highlightOn ? 'true' : 'false');
}

/* Текущие индексы из полей ввода — сервер подсвечивает именно их,
   даже если настройки ещё не сохранены */
function collectTargets() {
  const deviceId = parseInt($('device-select').value, 10);
  const targets = {};
  const mic = parseInt($('mic-index').value, 10);
  const sound = parseInt($('sound-index').value, 10);

  if (Number.isInteger(mic)) {
    targets.mic = { ledIndex: mic };
    if (Number.isInteger(deviceId)) targets.mic.deviceId = deviceId;
  }
  if (Number.isInteger(sound)) {
    targets.sound = { ledIndex: sound };
    if (Number.isInteger(deviceId)) targets.sound.deviceId = deviceId;
  }
  return targets;
}

async function toggleHighlight() {
  const enable = !highlightOn;
  const btn = $('btn-highlight');
  btn.disabled = true;
  try {
    const data = await api('/api/highlight', {
      method: 'POST',
      body: JSON.stringify({ enabled: enable, targets: collectTargets() })
    });
    renderHighlightBtn(data.highlight.enabled);
    toast(data.highlight.enabled
      ? 'Подсветка включена — LED-кнопки горят жёлтым.'
      : 'Подсветка выключена — исходные цвета восстановлены.');
  } catch (e) {
    toast(`Подсветка: ${e.message}`, false);
  } finally {
    btn.disabled = false;
  }
}

/* При правке индекса — сразу переносим подсветку на новое значение
   (с задержкой, чтобы не дёргать сервер на каждую цифру) */
let targetsTimer = null;

function scheduleHighlightTargets() {
  if (!highlightOn) return;
  clearTimeout(targetsTimer);
  targetsTimer = setTimeout(async () => {
    try {
      await api('/api/highlight', {
        method: 'POST',
        body: JSON.stringify({ enabled: true, targets: collectTargets() })
      });
    } catch (e) {
      /* молча: статус подтянется следующим опросом */
    }
  }, 500);
}

/* ---------- автозагрузка ---------- */

async function toggleAutostart() {
  const enabled = $('autostart').checked;
  try {
    const data = await api('/api/autostart', { method: 'POST', body: JSON.stringify({ enabled }) });
    $('autostart').checked = data.enabled;
    toast(data.enabled ? 'Автозагрузка включена.' : 'Автозагрузка отключена.');
  } catch (e) {
    $('autostart').checked = !enabled;
    toast(`Автозагрузка: ${e.message}`, false);
  }
}

/* ---------- журнал ---------- */

async function refreshLogs() {
  try {
    const data = await api('/api/logs');
    const view = $('log-view');
    view.textContent = data.lines.join('\n') || 'пока пусто';
    view.scrollTop = view.scrollHeight;
  } catch (e) {
    $('log-view').textContent = `Журнал недоступен: ${e.message}`;
  }
}

/* ---------- инициализация ---------- */

$('btn-devices').addEventListener('click', loadDevices);
$('btn-save').addEventListener('click', save);
$('btn-logs').addEventListener('click', refreshLogs);
$('autostart').addEventListener('change', toggleAutostart);
$('btn-highlight').addEventListener('click', toggleHighlight);
$('device-select').addEventListener('change', () => { updateLedHint(); scheduleHighlightTargets(); });
$('mic-index').addEventListener('input', () => { updateLedHint(); scheduleHighlightTargets(); });
$('sound-index').addEventListener('input', () => { updateLedHint(); scheduleHighlightTargets(); });

refreshStatus();
refreshLogs();
setInterval(refreshStatus, 2000);
setInterval(refreshLogs, 8000);
