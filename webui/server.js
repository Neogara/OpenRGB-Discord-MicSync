/*---------------------------------------------------------*\
| webui/server.js                                            |
|                                                           |
|   Локальная страница настроек (только 127.0.0.1):         |
|   - статус Discord/OpenRGB в реальном времени             |
|   - список устройств OpenRGB, LED-индексы, цвета          |
|   - живое применение настроек без перезапуска             |
|   - журнал последних событий                              |
|   Зависимостей нет — только модуль http + статика.        |
\*---------------------------------------------------------*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const { log, error, getRecentLines } = require('../logger');
const settingsStore = require('../settings');
const autostart = require('../autostart');
const { getRpcStatus, reapplyCurrentState } = require('../discordRpc');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 64 * 1024;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

function sendJson(res, code, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;

        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(Object.assign(new Error('тело запроса слишком большое'), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('error', (err) => reject(err));
        req.on('end', () => {
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('ожидался JSON-объект');
                }
                resolve(parsed);
            } catch (err) {
                reject(Object.assign(new Error(`некорректный JSON: ${err.message}`), { status: 400 }));
            }
        });
    });
}

/* Имена страниц без расширения -> файлы (ссылка в адресной строке) */
const PAGE_ROUTES = {
    '/': 'index.html',
    '/auth-success': 'auth-success.html'
};

function serveStatic(res, pathname) {
    const rel = PAGE_ROUTES[pathname] || pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));

    if (!file.startsWith(PUBLIC_DIR)) {
        res.writeHead(403).end('Forbidden');
        return;
    }

    fs.readFile(file, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не найдено');
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
    });
}

async function handleApi(req, res, url, openrgb) {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/status') {
        sendJson(res, 200, {
            discord: getRpcStatus(),
            openrgb: openrgb.getStatus(),
            settings: settingsStore.getSettings(),
            autostart: { enabled: autostart.isEnabled(), platform: process.platform }
        });
        return;
    }

    if (route === 'GET /api/devices') {
        try {
            const devices = await openrgb.getDevices();
            sendJson(res, 200, { devices });
        } catch (err) {
            sendJson(res, 503, { error: err.message });
        }
        return;
    }

    if (route === 'GET /api/logs') {
        sendJson(res, 200, { lines: getRecentLines(150) });
        return;
    }

    if (route === 'POST /api/settings') {
        let body;
        try {
            body = await readJson(req);
        } catch (err) {
            sendJson(res, err.status || 400, { error: err.message });
            return;
        }

        const prev = settingsStore.getSettings();
        const hostChanged = body.openrgb
            && (body.openrgb.host !== prev.openrgb.host || body.openrgb.port !== prev.openrgb.port);

        /* Сначала сбрасываем накопленное состояние цветов, затем сохраняем:
           подписчик на 'changed' применит новые значения (и, если включена
           подсветка, переедет на новые индексы) */
        openrgb.resetState();

        let saved;
        try {
            saved = settingsStore.saveSettings(body);
        } catch (err) {
            if (err.validation) {
                sendJson(res, 400, { error: err.message });
                return;
            }
            sendJson(res, 500, { error: err.message });
            return;
        }

        if (hostChanged) {
            log('WebUI', 'Host/port OpenRGB изменился — переподключаюсь...');
            openrgb.reconnectNow().catch((err) => error('WebUI', `Переподключение не удалось: ${err.message}`));
        }

        /* Страховка: если Discord-сессия активна, пере-применяем состояние */
        reapplyCurrentState();

        sendJson(res, 200, { ok: true, settings: saved });
        return;
    }

    if (route === 'POST /api/test-led') {
        let body;
        try {
            body = await readJson(req);
        } catch (err) {
            sendJson(res, err.status || 400, { error: err.message });
            return;
        }

        const { deviceId, ledIndex, color } = body;
        const intsOk = Number.isInteger(deviceId) && deviceId >= 0 && deviceId <= 1024
            && Number.isInteger(ledIndex) && ledIndex >= 0 && ledIndex <= 1023;
        const colorOk = color && ['red', 'green', 'blue']
            .every((k) => Number.isInteger(color[k]) && color[k] >= 0 && color[k] <= 255);

        if (!intsOk || !colorOk) {
            sendJson(res, 400, { error: 'Некорректные deviceId/ledIndex/color' });
            return;
        }

        try {
            const info = await openrgb.testLed(deviceId, ledIndex, color);
            sendJson(res, 200, { ok: true, device: info });
        } catch (err) {
            sendJson(res, err.status || 503, { error: err.message });
        }
        return;
    }

    if (route === 'POST /api/highlight') {
        let body;
        try {
            body = await readJson(req);
        } catch (err) {
            sendJson(res, err.status || 400, { error: err.message });
            return;
        }

        if (typeof body.enabled !== 'boolean') {
            sendJson(res, 400, { error: 'Ожидается {enabled: true|false, targets?}' });
            return;
        }

        /* targets (необязательно): текущие значения полей ввода со
           страницы — подсветка следует за индексами до сохранения */
        let targets;
        if (body.targets !== undefined) {
            if (!body.targets || typeof body.targets !== 'object' || Array.isArray(body.targets)) {
                sendJson(res, 400, { error: 'targets должен быть объектом' });
                return;
            }
            targets = {};
            for (const role of ['mic', 'sound']) {
                const t = body.targets[role];
                if (t === undefined) continue;
                if (!t || typeof t !== 'object' || Array.isArray(t)
                    || !Number.isInteger(t.ledIndex) || t.ledIndex < 0 || t.ledIndex > 1023
                    || (t.deviceId !== undefined && (!Number.isInteger(t.deviceId) || t.deviceId < 0 || t.deviceId > 1024))) {
                    sendJson(res, 400, { error: `Некорректные targets.${role}` });
                    return;
                }
                targets[role] = { ledIndex: t.ledIndex };
                if (t.deviceId !== undefined) targets[role].deviceId = t.deviceId;
            }
        }

        try {
            const state = await openrgb.setHighlight(body.enabled, targets);
            sendJson(res, 200, { ok: true, highlight: state });
        } catch (err) {
            sendJson(res, err.status || 503, { error: err.message });
        }
        return;
    }

    if (route === 'POST /api/autostart') {
        let body;
        try {
            body = await readJson(req);
        } catch (err) {
            sendJson(res, err.status || 400, { error: err.message });
            return;
        }

        if (typeof body.enabled !== 'boolean') {
            sendJson(res, 400, { error: 'Ожидается {enabled: true|false}' });
            return;
        }

        const result = body.enabled ? autostart.enable() : autostart.disable();
        if (!result.ok) {
            sendJson(res, 500, { error: result.error });
            return;
        }
        sendJson(res, 200, { ok: true, enabled: result.enabled });
        return;
    }

    sendJson(res, 404, { error: `Неизвестный эндпоинт: ${route}` });
}

function startWebUI({ openrgb }) {
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://127.0.0.1');
            if (url.pathname.startsWith('/api/')) {
                await handleApi(req, res, url, openrgb);
                return;
            }
            serveStatic(res, url.pathname);
        } catch (err) {
            error('WebUI', `Ошибка запроса: ${err.message}`);
            if (!res.headersSent) sendJson(res, 500, { error: err.message });
        }
    });

    const port = settingsStore.getSettings().webui.port;

    server.on('error', (err) => {
        error('WebUI', `Страница настроек не запустилась (порт ${port}): ${err.message}`);
    });

    server.listen(port, '127.0.0.1', () => {
        const pageUrl = `http://127.0.0.1:${port}`;
        log('WebUI', `Страница настроек: ${pageUrl}`);
        if (settingsStore.getSettings().webui.openOnStart) {
            autostart.openInBrowser(pageUrl);
        }
    });

    return server;
}

module.exports = { startWebUI };
