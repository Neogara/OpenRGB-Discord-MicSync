const path = require('path');
/* Путь относительно файла, а не cwd: иначе при запуске из другого
   каталога (автозагрузка, планировщик) secrets.env не находится */
require('dotenv').config({ path: path.join(__dirname, 'secrets.env') });

const settings = require('./settings');

/*
* Константы инфраструктуры. Пользовательские настройки (устройство,
* LED-индексы, цвета, порты) живут в settings.json и читаются через
* settings.getSettings(); OPENRGB_HOST/PORT вычисляются на каждый доступ,
* чтобы изменения применялись без перезапуска. Переменные окружения
* имеют приоритет (нужны для тестов и нестандартных запусков).
*/
module.exports = {
  CLIENT_ID: process.env.CLIENT_ID,
  CLIENT_SECRET: process.env.CLIENT_SECRET,

  REDIRECT_URI: 'http://localhost:3000',
  AUTH_SERVER_PORT: 3000,
  TOKEN_FILE: path.join(__dirname, 'discord_token.json'),

  RECONNECT_INTERVAL: 5000,

  /* Имя пайпа Discord (например discord-ipc-5 для Canary).
     Пусто = автоматический перебор discord-ipc-0..9 */
  DISCORD_PIPE: process.env.DISCORD_PIPE || '',

  get OPENRGB_HOST() {
    return process.env.OPENRGB_HOST || settings.getSettings().openrgb.host;
  },
  get OPENRGB_PORT() {
    const envPort = parseInt(process.env.OPENRGB_PORT, 10);
    return Number.isInteger(envPort) && envPort > 0 ? envPort : settings.getSettings().openrgb.port;
  }
};
