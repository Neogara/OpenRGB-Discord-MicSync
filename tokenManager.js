const { log, error } = require('./logger');
const fs = require('fs').promises;
const axios = require('axios');
const http = require('http');
const path = require('path');
const config = require('./config');
const settingsStore = require('./settings');

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
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );
    return response.data;
  } catch (err) {
    throw new Error(`Ошибка обмена кода на токен: ${err.response ? JSON.stringify(err.response.data) : err.message}`);
  }
}

/*
* Страница результата авторизации живёт на том же порту, что и настройки
* (127.0.0.1), — после входа пользователь сразу оказывается «у себя».
* Сам OAuth-redirect остаётся на localhost:3000: он зарегистрирован в
* Discord Developer Portal и не должен зависеть от настраиваемого порта.
*/
/* Базовый адрес страницы настроек */
function getWebuiBase() {
  return `http://127.0.0.1:${settingsStore.getSettings().webui.port}`;
}

function buildAuthResultUrl({ error: isError = false, msg = '' } = {}) {
  const params = new URLSearchParams();
  if (isError) {
    params.set('error', '1');
    if (msg) params.set('msg', msg);
  }
  const qs = params.toString();
  return `${getWebuiBase()}/auth-success${qs ? `?${qs}` : ''}`;
}

/* Жива ли страница настроек (решает: редирект или свой HTML) */
function probeWebui(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const req = http.get(`${url}/api/status`, (res) => {
      res.resume();
      done(res.statusCode === 200);
      req.destroy();
    });
    req.on('error', () => done(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done(false);
    });
  });
}

/* Страница результата отдаётся самим auth-сервером, если страница
   настроек не запустилась (занятый порт) — токен уже сохранён,
   и пользователь должен об этом узнать */
async function serveAuthResultInline(res, { error: isError = false, msg = '' } = {}) {
  try {
    const raw = await fs.readFile(path.join(__dirname, 'webui', 'public', 'auth-success.html'), 'utf8');
    const inline = `<script>window.__AUTH_INLINE__=${JSON.stringify({
      error: isError,
      msg,
      port: settingsStore.getSettings().webui.port
    })};</script>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(raw.replace('</head>', `${inline}</head>`));
  } catch (err) {
    error('TokenManager', `Не удалось отдать страницу результата: ${err.message}`);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(isError ? `Ошибка авторизации: ${msg || 'нет кода'}. Токен не сохранён.`
      : 'Токен получен, можно закрыть вкладку.');
  }
}

/* Статика страницы результата: когда HTML отдан auth-сервером (порт 3000),
   стили и скрипт браузер запросит с того же порта */
const INLINE_ASSETS = {
  '/style.css': ['webui/public/style.css', 'text/css; charset=utf-8'],
  '/auth-success.js': ['webui/public/auth-success.js', 'text/javascript; charset=utf-8']
};

function serveInlineAsset(res, pathname) {
  const asset = INLINE_ASSETS[pathname];
  if (!asset) return false;
  fs.readFile(path.join(__dirname, asset[0]))
    .then((data) => {
      res.writeHead(200, { 'Content-Type': asset[1] });
      res.end(data);
    })
    .catch(() => res.writeHead(404).end('Не найдено'));
  return true;
}

/* 302 на страницу настроек; при недоступной странице — свой HTML.
   Возвращает true, если был редирект (сервер можно закрывать сразу) */
async function redirectAuthResult(res, result) {
  const target = buildAuthResultUrl(result);
  if (await probeWebui(getWebuiBase())) {
    res.writeHead(302, { Location: target });
    res.end();
    return true;
  }
  error('TokenManager', 'Страница настроек не отвечает — результат отдан с auth-сервера.');
  await serveAuthResultInline(res, result);
  return false;
}

async function startAuthServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      let url;
      try {
        url = new URL(req.url, `http://localhost:${config.AUTH_SERVER_PORT}`);
      } catch (err) {
        res.writeHead(400).end('Некорректный запрос.');
        return;
      }
      const query = url.searchParams;

      /* Статика inline-страницы результата (HTML отдан этим же сервером) */
      if (req.method === 'GET' && serveInlineAsset(res, url.pathname)) return;

      const code = query.get('code');
      const oauthError = query.get('error');

      /* Нет ни кода, ни ошибки от Discord — это не наш редирект
         (например, браузер запросил favicon) */
      if (!code && !oauthError) {
        res.writeHead(400).end('Код авторизации не предоставлен.');
        return;
      }

      if (!code) {
        /* Пользователь отказал в доступе или Discord вернул ошибку.
           Сервер оставляем слушающим, а промис — ожидающим: повторная
           авторизация (ссылка печатается в лог) подхватится без
           перезапуска, а цикл startRpc не откроет браузер вхолостую */
        const msg = query.get('error_description') || oauthError;
        error('TokenManager', `Авторизация отклонена: ${msg}`);
        await redirectAuthResult(res, { error: true, msg });
        return;
      }

      try {
        const tokenData = await exchangeCodeForToken(code);
        await saveToken(tokenData);
        const redirected = await redirectAuthResult(res, { error: false });
        resolve(tokenData.access_token);
        /* При inline-отдаче браузер ещё запросит статику с этого же
           порта — закрываем сервер после паузы, а не сразу */
        setTimeout(() => {
          server.close(() => log('TokenManager', 'Сервер авторизации закрыт.'));
        }, redirected ? 0 : 5000);
      } catch (err) {
        error('TokenManager', err.message);
        await redirectAuthResult(res, { error: true, msg: err.message });
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

module.exports = {
  loadToken,
  saveToken,
  isTokenExpired,
  startAuthServer,
  refreshAccessToken,
  getValidAccessToken,
  buildAuthResultUrl,
  serveAuthResultInline,
  serveInlineAsset
};