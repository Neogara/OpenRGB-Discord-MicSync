const { log, error } = require('./logger');
const fs = require('fs').promises;
const axios = require('axios');
const http = require('http');
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
  if (!token || !token.access_token) return true;
  /* Нет данных о сроке жизни — считаем токен валидным,
     реальная проверка произойдёт при AUTHENTICATE */
  if (typeof token.saved_at !== 'number' || typeof token.expires_in !== 'number') return false;
  /* Обновляем за минуту до истечения */
  return Date.now() >= token.saved_at + (token.expires_in - 60) * 1000;
}

async function refreshAccessToken(token) {
  try {
    const response = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: config.CLIENT_ID,
        client_secret: config.CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return response.data;
  } catch (err) {
    throw new Error(`обновление токена не удалось: ${err.response ? JSON.stringify(err.response.data) : err.message}`);
  }
}

/*
* Возвращает валидный access_token:
*   1. свежий сохранённый токен;
*   2. refresh-токен (обязательно, если refresh=true — например после
*      отказа AUTHENTICATE);
*   3. полная авторизация через браузер.
*/
async function getValidAccessToken({ refresh = false } = {}) {
  const token = await loadToken();

  if (!refresh && token && !isTokenExpired(token)) {
    return token.access_token;
  }

  if (token && token.refresh_token) {
    try {
      const fresh = await refreshAccessToken(token);
      const merged = Object.assign({}, token, fresh);
      await saveToken(merged);
      log('TokenManager', 'Токен обновлён через refresh_token.');
      return merged.access_token;
    } catch (err) {
      error('TokenManager', `${err.message}. Требуется повторная авторизация.`);
    }
  } else if (token) {
    log('TokenManager', 'Сохранённого refresh-токена нет, нужна авторизация.');
  }

  return startAuthServer();
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
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      let query;
      try {
        query = new URL(req.url, `http://localhost:${config.AUTH_SERVER_PORT}`).searchParams;
      } catch (err) {
        res.writeHead(400).end('Некорректный запрос.');
        return;
      }

      const code = query.get('code');
      if (!code) {
        res.writeHead(400).end('Код авторизации не предоставлен.');
        return;
      }
      try {
        const tokenData = await exchangeCodeForToken(code);
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

    /* Порт занят/не удалось слушать — иначе промис завис бы навсегда */
    server.on('error', (err) => {
      error('TokenManager', `Не удалось запустить сервер авторизации: ${err.message}`);
      reject(err);
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

module.exports = { loadToken, saveToken, isTokenExpired, startAuthServer, refreshAccessToken, getValidAccessToken };