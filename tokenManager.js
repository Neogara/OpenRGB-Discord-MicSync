const { log, error } = require('./logger');
const fs = require('fs').promises;
const axios = require('axios');
const http = require('http');
const url = require('url');
const config = require('./config');

async function loadToken() {
  try {
    const data = await fs.readFile(config.TOKEN_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') log('TokenManager', 'Файл с токеном не найден.');
    else error('TokenManager', `Ошибка чтения токена: ${err.message}`);
    return null;
  }
}

async function saveToken(tokenData) {
  try {
    tokenData.saved_at = Date.now();
    await fs.writeFile(config.TOKEN_FILE, JSON.stringify(tokenData, null, 2), 'utf8');
    log('TokenManager', 'Токен сохранён.');
  } catch (err) {
    error('TokenManager', `Ошибка сохранения токена: ${err.message}`);
  }
}

function isTokenExpired(token) {
  return Date.now() > token.saved_at + token.expires_in * 1000;
}

async function exchangeCodeForToken(code) {
  try {
    const response = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: config.CLIENT_ID,
        client_secret: config.CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.REDIRECT_URI
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return response.data;
  } catch (err) {
    throw new Error(`Ошибка обмена кода на токен: ${err.response ? JSON.stringify(err.response.data) : err.message}`);
  }
}

async function startAuthServer() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const query = url.parse(req.url, true).query;
      if (!query.code) {
        res.writeHead(400).end('Код авторизации не предоставлен.');
        return;
      }
      try {
        const tokenData = await exchangeCodeForToken(query.code);
        await saveToken(tokenData);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Токен получен, можно закрыть вкладку.', 'utf-8');
        server.close(() => {
          log('TokenManager', 'Сервер авторизации закрыт.');
          resolve(tokenData.access_token);
        });
      } catch (err) {
        error('TokenManager', err.message);
        res.writeHead(500).end('Ошибка при получении токена.');
      }
    });

    server.listen(config.AUTH_SERVER_PORT, () => {
      const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${config.CLIENT_ID}&redirect_uri=${encodeURIComponent(
        config.REDIRECT_URI
      )}&response_type=code&scope=rpc%20rpc.voice.read`;
      log('TokenManager', `Открываю браузер для авторизации: ${authUrl}`);
      import('open')
        .then((openModule) => openModule.default(authUrl))
        .catch((err) => error('TokenManager', `Ошибка открытия браузера: ${err}`));
    });
  });
}

module.exports = { loadToken, saveToken, isTokenExpired, startAuthServer };