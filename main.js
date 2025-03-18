const {error, log} = require('./logger');
const { connectOpenRGB } = require('./openRGBController');
const { loadToken, isTokenExpired, startAuthServer } = require('./tokenManager');
const { startRpc } = require('./discordRpc');

(async () => {
  try {
    const openRGBClient = await connectOpenRGB();
    let token = await loadToken();
    if (!token || isTokenExpired(token)) {
      log('Main', 'Нет действительного токена, запускаем авторизацию...');
      const accessToken = await startAuthServer();
      token = { access_token: accessToken };
    }
    await startRpc(token.access_token, openRGBClient);
  } catch (err) {
    error('Main', err.message);
  }
})();

process.on('uncaughtException', (err) => error('Global', `Непойманное исключение: ${err.message}`));
process.on('unhandledRejection', (reason) => error('Global', `Необработанный отказ: ${reason}`));