/* Логгер: вывод в консоль + дописывание в logs/app-<дата>.log */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
const MAX_LOG_SIZE = 5 * 1024 * 1024; /* дальше — ротация в .old.log */

let stream = null;
let streamDate = null;

function getStream() {
  const date = new Date().toISOString().slice(0, 10);
  if (stream && streamDate === date) return stream;

  try {
    if (stream) {
      try { stream.end(); } catch (e) { /* ignore */ }
      stream = null;
    }

    fs.mkdirSync(LOG_DIR, { recursive: true });

    const file = path.join(LOG_DIR, `app-${date}.log`);
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_SIZE) {
      fs.renameSync(file, file.replace(/\.log$/, '.old.log'));
    }

    stream = fs.createWriteStream(file, { flags: 'a' });
    stream.on('error', () => { stream = null; streamDate = null; });
    streamDate = date;
  } catch (err) {
    /* Нет прав на запись — работаем только в консоль */
    stream = null;
    streamDate = null;
  }

  return stream;
}

function writeToFile(level, source, message) {
  const line = `${new Date().toISOString()} [${level}] [${source}] ${message}`;
  note(line);
  const s = getStream();
  if (!s) return;
  try {
    s.write(line + '\n');
  } catch (e) { /* ignore */ }
}

/* Кольцевой буфер последних строк — для журнала на странице настроек */
const RECENT_LIMIT = 300;
const recent = [];

function note(line) {
  recent.push(line);
  if (recent.length > RECENT_LIMIT) recent.shift();
}

function getRecentLines(count = 100) {
  return recent.slice(-count);
}

function log(source, message) {
  console.log(`[${source}] ${message}`);
  writeToFile('INFO', source, message);
}

function error(source, message) {
  console.error(`[${source} ERROR] ${message}`);
  writeToFile('ERROR', source, message);
}

module.exports = { log, error, getRecentLines, LOG_DIR };
