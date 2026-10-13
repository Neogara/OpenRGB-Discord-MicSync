/*---------------------------------------------------------*\
| settings.js                                                |
|                                                           |
|   Пользовательские настройки (settings.json):             |
|   - дефолты совпадают с прежним config.js                 |
|   - кривые значения откатываются к дефолтам с предупрежд. |
|   - валидация при сохранении (saveSettings бросает ошибку) |
|   - событие 'changed' для живого применения без перезапуска|
\*---------------------------------------------------------*/

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { log, error } = require('./logger');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const DEFAULTS = {
  device: {
    /* 0 — Palit GeForce RTX 5080, 1 — Red Square Keyrox TKL
       (список печатается в лог при старте и виден на странице настроек) */
    keyboardDeviceId: 1,
    micLedIndex: 15,
    soundLedIndex: 14
  },
  colors: {
    micMuted: { red: 0, green: 255, blue: 0 },
    micUnmuted: { red: 255, green: 0, blue: 0 },
    soundDeaf: { red: 0, green: 255, blue: 0 },
    soundUndeaf: { red: 255, green: 0, blue: 0 }
  },
  openrgb: { host: 'localhost', port: 6742 },
  webui: { port: 3001, openOnStart: false },
  autostart: false
};

const emitter = new EventEmitter();

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

function isInt(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

function isColor(value) {
  return value && typeof value === 'object'
    && ['red', 'green', 'blue'].every((k) => isInt(value[k]) && value[k] >= 0 && value[k] <= 255);
}

function mergeDeep(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = mergeDeep(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/*
* Приводит произвольный объект к валидной структуре настроек.
* Некорректные поля заменяются дефолтами и попадают в errors.
*/
function normalize(input = {}) {
  const errors = [];
  const out = cloneDefaults();

  const takeInt = (target, key, source, min, max, label) => {
    const value = source ? source[key] : undefined;
    if (value === undefined) return;
    if (!isInt(value) || value < min || value > max) {
      errors.push(`${label}: ожидается целое ${min}..${max}, получено ${JSON.stringify(value)}`);
      return;
    }
    target[key] = value;
  };

  const takeBool = (target, key, source, label) => {
    const value = source ? source[key] : undefined;
    if (value === undefined) return;
    if (typeof value !== 'boolean') {
      errors.push(`${label}: ожидается true/false, получено ${JSON.stringify(value)}`);
      return;
    }
    target[key] = value;
  };

  const takeColor = (target, key, source, label) => {
    const value = source ? source[key] : undefined;
    if (value === undefined) return;
    if (!isColor(value)) {
      errors.push(`${label}: ожидается объект {red, green, blue} 0..255, получено ${JSON.stringify(value)}`);
      return;
    }
    target[key] = { red: value.red, green: value.green, blue: value.blue };
  };

  takeInt(out.device, 'keyboardDeviceId', input.device, 0, 1024, 'device.keyboardDeviceId');
  takeInt(out.device, 'micLedIndex', input.device, 0, 1023, 'device.micLedIndex');
  takeInt(out.device, 'soundLedIndex', input.device, 0, 1023, 'device.soundLedIndex');

  takeColor(out.colors, 'micMuted', input.colors, 'colors.micMuted');
  takeColor(out.colors, 'micUnmuted', input.colors, 'colors.micUnmuted');
  takeColor(out.colors, 'soundDeaf', input.colors, 'colors.soundDeaf');
  takeColor(out.colors, 'soundUndeaf', input.colors, 'colors.soundUndeaf');

  takeInt(out.openrgb, 'port', input.openrgb, 1, 65535, 'openrgb.port');
  if (input.openrgb && input.openrgb.host !== undefined) {
    const host = input.openrgb.host;
    if (typeof host !== 'string' || !host.trim() || host.length > 253) {
      errors.push(`openrgb.host: ожидается непустая строка, получено ${JSON.stringify(host)}`);
    } else {
      out.openrgb.host = host.trim();
    }
  }

  takeInt(out.webui, 'port', input.webui, 1, 65535, 'webui.port');
  takeBool(out.webui, 'openOnStart', input.webui, 'webui.openOnStart');

  takeBool(out, 'autostart', input, 'autostart');

  return { settings: out, errors };
}

function loadInitial() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      error('Settings', `settings.json не прочитан (${err.message}) — использую настройки по умолчанию.`);
    }
  }
  if (!raw || typeof raw !== 'object') return cloneDefaults();

  const { settings, errors } = normalize(raw);
  for (const message of errors) {
    error('Settings', `игнорировано некорректное значение: ${message}`);
  }
  return settings;
}

let current = loadInitial();

function getSettings() {
  return current;
}

/*
* Сохраняет настройки (глубокое слияние с текущими) и уведомляет подписчиков.
* Бросает Error с полем validation=true, если данные некорректны.
*/
function saveSettings(patch) {
  const merged = mergeDeep(current, patch || {});
  const { settings, errors } = normalize(merged);

  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.validation = true;
    throw err;
  }

  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);

  current = settings;
  log('Settings', `Настройки сохранены в ${path.basename(SETTINGS_FILE)}.`);
  emitter.emit('changed', settings);
  return settings;
}

function onChange(callback) {
  emitter.on('changed', callback);
}

function offChange(callback) {
  emitter.removeListener('changed', callback);
}

module.exports = { getSettings, saveSettings, onChange, offChange, DEFAULTS, SETTINGS_FILE };
