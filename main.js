const { error } = require('./logger');
const { OpenRGBManager } = require('./openRGBController');
const { getValidAccessToken } = require('./tokenManager');
const { startRpc } = require('./discordRpc');
const { startWebUI } = require('./webui/server');

(async () => {
  try {
    /* OpenRGB подключаем в фоне: старт приложения не блокируется,
       даже если OpenRGB ещё не запущен */
    const openrgb = new OpenRGBManager();
    openrgb.start();

    /* Страница настроек на 127.0.0.1 (порт — из settings.json) */
    startWebUI({ openrgb });

    /* startRpc сам крутится в бесконечном цикле переподключений */
    await startRpc(getValidAccessToken, openrgb);
  } catch (err) {
    error('Main', err.message);
  }
})();

process.on('uncaughtException', (err) => error('Global', `Непойманное исключение: ${err.message}`));
process.on('unhandledRejection', (reason) => error('Global', `Необработанный отказ: ${reason}`));
