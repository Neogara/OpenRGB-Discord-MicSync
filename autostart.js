/*---------------------------------------------------------*\
| autostart.js                                               |
|                                                           |
|   Автозагрузка в Windows: скрипт .vbs в папке             |
|   «Startup» (%APPDATA%\Microsoft\Windows\Start Menu\      |
|   Programs\Startup). Запуск приложения скрытым окном —    |
|   логи всё равно пишутся в logs/.                         |
|   Ноль зависимостей; отключается просто удалением файла.  |
\*---------------------------------------------------------*/

const fs = require('fs');
const path = require('path');
const { log, error } = require('./logger');

const SCRIPT_NAME = 'OpenRGB-Discord-MicSync.vbs';

function startupDir() {
  /* Для тестов папка переопределяется переменной окружения */
  if (process.env.MICSYNC_STARTUP_DIR) return process.env.MICSYNC_STARTUP_DIR;
  const appData = process.env.APPDATA || '';
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function scriptPath() {
  return path.join(startupDir(), SCRIPT_NAME);
}

function isEnabled() {
  try {
    return fs.existsSync(scriptPath());
  } catch (err) {
    return false;
  }
}

function enable() {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Автозагрузка поддерживается только на Windows' };
  }

  const nodeExe = process.execPath;   /* путь к node.exe */
  const appMain = path.join(__dirname, 'main.js');
  const dir = __dirname;

  /* WScript.Shell.Run: 0 = скрытое окно, False = не ждать завершения */
  const content = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${dir}"`,
    `sh.Run """${nodeExe}"" ""${appMain}""", 0, False`,
    ''
  ].join('\r\n');

  try {
    fs.mkdirSync(startupDir(), { recursive: true });
    fs.writeFileSync(scriptPath(), content, 'utf8');
    log('Autostart', `Автозагрузка включена (${scriptPath()}).`);
    return { ok: true, enabled: true };
  } catch (err) {
    error('Autostart', `Не удалось включить автозагрузку: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

function disable() {
  try {
    if (fs.existsSync(scriptPath())) {
      fs.unlinkSync(scriptPath());
      log('Autostart', 'Автозагрузка отключена.');
    }
    return { ok: true, enabled: false };
  } catch (err) {
    error('Autostart', `Не удалось отключить автозагрузку: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/* Открывает URL в браузере по умолчанию (open@10 — ESM-only, через import) */
function openInBrowser(url) {
  return import('open')
    .then((mod) => mod.default(url))
    .catch((err) => error('WebUI', `Не удалось открыть браузер: ${err.message}`));
}

module.exports = { isEnabled, enable, disable, openInBrowser, SCRIPT_NAME };
