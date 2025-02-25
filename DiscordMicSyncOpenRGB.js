require('dotenv').config({path: './secrets.env'});
const {RPClient, RPCEvent} = require('@corwinjs/rpcord');
const OpenRGB = require('openrgb-sdk');
const http = require('http');
const axios = require('axios');
const url = require('url');
const fs = require('fs').promises;
const path = require('path');

// Конфигурация приложения
const config = {
    CLIENT_ID: process.env.CLIENT_ID,
    CLIENT_SECRET: process.env.CLIENT_SECRET,

    REDIRECT_URI: 'http://localhost:3000',
    TOKEN_FILE: path.join(__dirname, 'discord_token.json'), // Файл с токеном Discord

    RECONNECT_INTERVAL: 5000,            // Интервал переподключения в мс

    OPENRGB_HOST: 'localhost', // IP-адрес OpenRGB SDK Server
    OPENRGB_PORT: 6742,        // Порт OpenRGB SDK Server

    KEYBOARD_DEVICE_ID: 0,  // ID устройства (как настроено в OpenRGB)
    MIC_CONTROL_LED_INDEX: 15,  // Индекс LED (кнопки) для управления микрофоном
    SOUND_CONTROL_LED_INDEX: 14, // Индекс LED (кнопки) для управления звуком
};

// Заданные цвета (ON - включено, OFF - выключено)
const OFF_COLOR = {red: 255, green: 0, blue: 0};
const ON_COLOR = {red: 0, green: 255, blue: 0};

if (!config.CLIENT_SECRET) {
    console.error('CLIENT_SECRET не найден в secrets.env');
    process.exit(1);
}

if (!config.CLIENT_ID) {
    console.error('CLIENT_ID не найден в secrets.env');
    process.exit(1);
}

/* ===================== Работа с токеном Discord ===================== */

/**
 * Чтение сохранённого токена из файла.
 */
async function loadToken() {
    try {
        const data = await fs.readFile(config.TOKEN_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('Файл с токеном не найден.');
            return null;
        }
        console.error('Ошибка чтения файла с токеном:', error.message);
        return null;
    }
}

/**
 * Сохранение токена в файл.
 */
async function saveToken(tokenData) {
    try {
        await fs.writeFile(config.TOKEN_FILE, JSON.stringify(tokenData, null, 2), 'utf8');
        console.log('Токен сохранён.');
    } catch (error) {
        console.error('Ошибка сохранения токена:', error.message);
    }
}

/**
 * Обмен кода авторизации на токен через Discord API.
 */
async function exchangeCodeForToken(code) {
    try {
        const response = await axios.post(
            'https://discord.com/api/oauth2/token',
            new URLSearchParams({
                client_id: config.CLIENT_ID,
                client_secret: config.CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: config.REDIRECT_URI,
            }),
            {headers: {'Content-Type': 'application/x-www-form-urlencoded'}}
        );
        return response.data;
    } catch (error) {
        throw new Error(
            `Ошибка обмена кода на токен: ${
                error.response ? JSON.stringify(error.response.data) : error.message
            }`
        );
    }
}

/**
 * Запуск локального HTTP-сервера для OAuth2 авторизации Discord.
 * После старта сервера автоматически открывается браузер с URL авторизации.
 */
async function startAuthServer() {
    return new Promise((resolve) => {
        const server = http.createServer(async (req, res) => {
            const query = url.parse(req.url, true).query;
            const code = query.code;
            if (!code) {
                res.writeHead(400).end('Код авторизации не предоставлен.');
                return;
            }
            try {
                const tokenData = await exchangeCodeForToken(code);
                await saveToken(tokenData);
                res.writeHead(200, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end('Токен получен, можно закрыть вкладку.', 'utf-8');
                server.close(() => {
                    console.log('Сервер авторизации закрыт.');
                    resolve(tokenData.access_token);
                });
            } catch (error) {
                console.error('Ошибка при обмене кода на токен:', error.message);
                res.writeHead(500).end('Ошибка при получении токена.');
            }
        });

        server.listen(config.AUTH_SERVER_PORT, () => {
            const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${config.CLIENT_ID}&redirect_uri=${encodeURIComponent(
                config.REDIRECT_URI
            )}&response_type=code&scope=rpc%20rpc.voice.read`;
            console.log(`Открываю браузер для авторизации:\n${authUrl}`);
            // Динамический импорт модуля open (ESM)
            import('open')
                .then((openModule) => {
                    openModule.default(authUrl).catch((err) =>
                        console.error('Ошибка при открытии браузера:', err)
                    );
                })
                .catch((err) => console.error('Ошибка импорта модуля open:', err));
        });
    });
}


async function printAvailableDevices(openrgbClient) {
    console.log();
    console.log("Список доступных устройств:")
    const controllerCount = await openrgbClient.getControllerCount()
    for (let deviceId = 0; deviceId < controllerCount; deviceId++) {
        var deviceData = await openrgbClient.getControllerData(deviceId)
        console.log(
            `${deviceId === config.KEYBOARD_DEVICE_ID ? "->" : "  "} id: ${deviceData.deviceId} name: ${deviceData.name} (${deviceData.description})`
        )
    }
    console.log();
}

/* ===================== Работа с OpenRGB ===================== */

/**
 * Функция для подключения к OpenRGB с повторными попытками, если сервер недоступен.
 * Возвращает подключённого клиента openrgb-sdk.
 */
async function connectOpenRGB() {
    console.log('Подключение к к OpenRGB SDK ...')
    const client = new OpenRGB.Client('DiscordAppOpenRGB', {
        host: config.OPENRGB_HOST,
        port: config.OPENRGB_PORT,
    });
    while (true) {
        try {
            await client.connect();
            console.log('Подключено к OpenRGB SDK.');
            await printAvailableDevices(client)

            return client;
        } catch (error) {
            console.error('Ошибка подключения к OpenRGB SDK:', error.message);
            console.log(`Повторное подключение через ${config.RECONNECT_INTERVAL} мс...`);
            await new Promise((resolve) => setTimeout(resolve, config.RECONNECT_INTERVAL));
        }
    }
}

/**
 * Обновление цвета LED с использованием openrgb-sdk.
 * Функция получает текущее состояние устройства, изменяет цвета LED,
 * и отправляет обновлённый массив цветов обратно на сервер OpenRGB.
 *
 * @param {OpenRGB.Client} openRGBClient - Клиент openrgb-sdk.
 * @param {number} deviceId - ID устройства (например, клавиатура == 0).
 * @param {Array} colors - Массив, содержащий пары [LED_index, {red, green, blue}].
 */
async function setKeyColor(openRGBClient, deviceId, colors) {
    try {
        const device = await openRGBClient.getControllerData(deviceId);
        let leds = device.colors;

        if (!leds || leds.length === 0) {
            console.log(`Устройство ${device.name} не имеет LED`);
            return;
        }

        for (let i = 0; i < colors.length; i++) {
            const ledIndex = colors[i][0];
            const color = colors[i][1];
            await openRGBClient.updateSingleLed(deviceId, ledIndex, color);
            console.log(
                `LED ${ledIndex} на устройстве ${device.name} установлен в цвет [${color.red}, ${color.green}, ${color.blue}]`
            );
        }
    } catch (error) {
        console.error('Ошибка при обновлении LED:', error);
    }
}

/* ===================== Discord RPC ===================== */

/**
 * Настройка и запуск Discord RPC.
 * При подключении запрашивается начальный статус микрофона и звука,
 * а затем подписывается на обновления голосовых настроек.
 *
 * @param {string} token - Discord access token.
 * @param {OpenRGB.Client} openRGBClient - Клиент openrgb-sdk.
 */
async function startRpc(token, openRGBClient) {
    console.log('Подключение к Discord RPC ...')
    const rpc = new RPClient(config.CLIENT_ID, {scopes: ['rpc', 'rpc.voice.read']});

    rpc.on('ready', () => console.log('Подключено к Discord RPC!'));
    rpc.on('error', (error) => {
        console.error('Ошибка RPC:', error);
    });

    while (true) {
        try {
            await rpc.connect();
            console.log('Подключено к Discord RPC.');
            break;
        } catch (error) {
            console.error('Ошибка подключения к Discord RPC:', error.message);
            console.log(`Повторное подключение через ${config.RECONNECT_INTERVAL} мс...`);
            await new Promise((resolve) => setTimeout(resolve, config.RECONNECT_INTERVAL));
        }
    }

    try {
        await rpc.authenticate(token);
        console.log('Аутентификация в Discord RPC успешна.');
    } catch (error) {
        console.error('Ошибка аутентификации в Discord RPC:', error.message);
        return null;
    }

    try {
        const voiceSettings = await rpc.getVoiceSettings();
        const micColor = voiceSettings.mute ? ON_COLOR : OFF_COLOR;
        const audioColor = voiceSettings.deaf ? ON_COLOR : OFF_COLOR;
        const newColors = [
            [config.MIC_CONTROL_LED_INDEX, micColor],
            [config.SOUND_CONTROL_LED_INDEX, audioColor],
        ];

        await setKeyColor(openRGBClient, config.KEYBOARD_DEVICE_ID, newColors);
        await rpc.subscribe(RPCEvent.VoiceSettingsUpdate);
        console.log('Подписка на обновления голосовых настроек выполнена.');
    } catch (error) {
        console.error('Ошибка при настройке обновлений голосовых настроек:', error.message);
    }

    rpc.on('voiceSettingsUpdate', async (voiceSettings) => {
        console.log('Обновление настроек голоса');
        const micColor = voiceSettings.mute ? ON_COLOR : OFF_COLOR;
        const audioColor = voiceSettings.deaf ? ON_COLOR : OFF_COLOR;
        const newColors = [
            [config.MIC_CONTROL_LED_INDEX, micColor],
            [config.SOUND_CONTROL_LED_INDEX, audioColor],
        ];

        await setKeyColor(openRGBClient, config.KEYBOARD_DEVICE_ID, newColors);
    });

    return rpc;
}

/* ===================== Основная функция ===================== */

async function main() {
    // Подключаемся к OpenRGB с повторными попытками
    const openRGBClient = await connectOpenRGB();

    // Загружаем или получаем токен Discord
    let tokenData = await loadToken();
    if (!tokenData || tokenData.expires_at <= Date.now()) {
        console.log('Нет действительного токена, запускаем авторизацию...');
        const accessToken = await startAuthServer();
        tokenData = {access_token: accessToken};
    }

    // Запускаем Discord RPC
    await startRpc(tokenData.access_token, openRGBClient);
}

main().catch((err) => console.error('Ошибка в работе приложения:', err));

// Глобальные обработчики ошибок
process.on('uncaughtException', (err) => console.error('Непойманное исключение:', err));
process.on('unhandledRejection', (reason, promise) =>
    console.error('Необработанный отказ в промисе:', reason)
);
