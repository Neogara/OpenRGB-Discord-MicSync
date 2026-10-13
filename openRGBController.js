/*---------------------------------------------------------*\
| openRGBController.js                                      |
|                                                           |
|   Управление подключением к OpenRGB SDK:                  |
|   - подключение в фоне (старт приложения не блокируется)  |
|   - автоматическое переподключение при обрыве             |
|   - кеш данных устройств (не ходим в API на каждое        |
|     событие)                                              |
|   - desired-state: желаемые цвета переприменяются         |
|     после переподключения                                 |
|   - событие 'status' (подключён/отключён) — для страницы  |
|     настроек, плюс методы getDevices()/testLed()          |
\*---------------------------------------------------------*/

const { EventEmitter } = require('events');
const { error, log } = require('./logger');
const OpenRGB = require('openrgb-sdk');
const config = require('./config');
const settingsStore = require('./settings');

const CONNECT_TIMEOUT = 5000;

/* Цвет подсветки LED при настройке индексов */
const HIGHLIGHT_COLOR = { red: 255, green: 200, blue: 0 };
const LED_OFF = { red: 0, green: 0, blue: 0 };

function rgbStr(c) {
    if (!c) return '—';
    return `#${[c.red, c.green, c.blue].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
}

class OpenRGBManager extends EventEmitter {
    constructor() {
        super();
        this.client = null;
        this.connectTask = null;
        this.reconnectTimer = null;
        this.flushScheduled = false;
        this.stopped = false;

        /* deviceId -> Map<ledIndex, color>: что должно гореть */
        this.desired = new Map();
        /* deviceId -> Map<ledIndex, color>: что реально записано в текущее
           соединение; сбрасывается при (пере)подключении, чтобы желаемые
           цвета применились заново */
        this.applied = new Map();
        /* deviceId -> { name, ledCount }, живёт до переподключения */
        this.deviceInfo = new Map();
        this.warnedLeds = new Set();

        /* Подсветка LED-кнопок (режим-тумблер «лампочка»): пока включена,
           выбранные индексы горят жёлтым; перед подсветкой запоминается
           цвет, который горел до неё, и он же восстанавливается */
        this.highlightOn = false;
        /* key "deviceId:ledIndex" -> { deviceId, ledIndex, before } */
        this.highlighted = new Map();
        /* Переопределения целей со страницы (текущие значения полей
           ввода, ещё не сохранённые в настройки): role -> { deviceId?, ledIndex } */
        this.highlightOverrides = new Map();

        /* После сохранения настроек подсветка переезжает на новые индексы */
        settingsStore.onChange(() => {
            this.highlightOverrides.clear();
            this.refreshHighlight().catch((err) => error('OpenRGB', `Подсветка: ${err.message}`));
        });

    }

    start() {
        this.connect();
    }

    getStatus() {
        const s = settingsStore.getSettings();
        return {
            connected: !!(this.client && this.client.isConnected),
            host: config.OPENRGB_HOST,
            port: config.OPENRGB_PORT,
            /* Информация о настроенном устройстве, если уже запрашивали */
            device: this.deviceInfo.get(s.device.keyboardDeviceId) || null,
            /* Состояние режима подсветки (для кнопки-лампочки на странице) */
            highlight: this.getHighlightState()
        };
    }

    /* Принимает пары [ledIndex, color] и запланированно применяет их */
    setLedColors(deviceId, ledColors) {
        const map = this.desired.get(deviceId) || new Map();
        for (const [ledIndex, color] of ledColors) {
            map.set(ledIndex, color);
        }
        this.desired.set(deviceId, map);
        this.scheduleFlush();
    }

    /* Сбросить всё накопленное состояние (после смены настроек):
       новые цвета/индексы применятся заново */
    resetState() {
        this.desired.clear();
        this.applied.clear();
        this.deviceInfo.clear();
        this.warnedLeds.clear();
        this.scheduleFlush();
    }

    /* ------------------------------------------------------------
     * Подсветка LED-кнопок (режим-тумблер «лампочка»).
     *
     * setHighlight(true,  targets?) — включить: выбранные индексы
     *   (по умолчанию — из настроек) горят жёлтым. Перед записью
     *   запоминается, что горело на LED до подсветки.
     * setHighlight(false) — выключить: каждому подсвеченному LED
     *   возвращается его исходный цвет (сначала текущий желаемый
     *   цвет, затем цвет до подсветки, и только потом чёрный).
     * targets — { mic?: { deviceId?, ledIndex }, sound?: {...} },
     *   нужно, чтобы подсветка следовала за полями ввода на странице.
     * ------------------------------------------------------------ */
    async setHighlight(enabled, targets) {
        this.highlightOn = !!enabled;

        if (enabled) {
            if (targets) this.setHighlightTargets(targets);

            if (!(await this.ensureConnected())) {
                this.highlightOn = false;
                this.highlightOverrides.clear();
                throw new Error('OpenRGB не подключён');
            }

            /* Индексы должны существовать у устройства — иначе 400 */
            try {
                await this.validateHighlightTargets();
            } catch (err) {
                this.highlightOn = false;
                this.highlightOverrides.clear();
                throw err;
            }
        } else {
            this.highlightOverrides.clear();
        }

        await this.refreshHighlight();
        return this.getHighlightState();
    }

    async validateHighlightTargets() {
        for (const t of this.getHighlightTargetList()) {
            const info = await this.getDeviceInfo(this.client, t.deviceId).catch(() => null);
            if (!info) {
                const err = new Error(`Устройство ${t.deviceId} не найдено`);
                err.status = 400;
                throw err;
            }
            if (t.ledIndex >= info.ledCount) {
                const err = new Error(`Индекс ${t.ledIndex} вне диапазона: у «${info.name}» ${info.ledCount} LED`);
                err.status = 400;
                throw err;
            }
        }
    }

    getHighlightState() {
        return {
            enabled: this.highlightOn,
            color: HIGHLIGHT_COLOR
        };
    }

    setHighlightTargets(targets) {
        this.highlightOverrides.clear();
        if (!targets || typeof targets !== 'object') return;

        for (const role of ['mic', 'sound']) {
            const t = targets[role];
            if (!t || typeof t !== 'object') continue;
            if (!Number.isInteger(t.ledIndex)) continue;

            const entry = { ledIndex: t.ledIndex };
            if (Number.isInteger(t.deviceId)) entry.deviceId = t.deviceId;
            this.highlightOverrides.set(role, entry);
        }
    }

    /* Что должно быть подсвечено сейчас (настройки + переопределения) */
    getHighlightTargetList() {
        const s = settingsStore.getSettings();
        const base = s.device.keyboardDeviceId;
        const list = [];

        for (const role of ['mic', 'sound']) {
            const override = this.highlightOverrides.get(role);
            const ledIndex = override ? override.ledIndex
                : (role === 'mic' ? s.device.micLedIndex : s.device.soundLedIndex);
            const deviceId = override && Number.isInteger(override.deviceId)
                ? override.deviceId : base;
            list.push({ deviceId, ledIndex });
        }
        return list;
    }

    /* Привести подсветку к актуальному набору целей:
       лишние — погасить с восстановлением цвета, недостающие — зажечь */
    async refreshHighlight() {
        if (!this.highlightOn) {
            for (const key of Array.from(this.highlighted.keys())) {
                await this.restoreHighlighted(key);
            }
            return;
        }

        const wanted = new Set();
        for (const t of this.getHighlightTargetList()) {
            wanted.add(`${t.deviceId}:${t.ledIndex}`);
        }

        for (const key of Array.from(this.highlighted.keys())) {
            if (!wanted.has(key)) await this.restoreHighlighted(key);
        }
        for (const t of this.getHighlightTargetList()) {
            const key = `${t.deviceId}:${t.ledIndex}`;
            if (!this.highlighted.has(key)) await this.lightUp(t.deviceId, t.ledIndex);
        }
    }

    /* Запомнить цвет LED и зажечь жёлтым */
    async lightUp(deviceId, ledIndex) {
        const client = this.client;
        if (!client || !client.isConnected) return;

        const info = await this.getDeviceInfo(client, deviceId).catch(() => null);
        if (!info) return;
        if (ledIndex >= info.ledCount) return;

        /* Цвет до подсветки: сначала рабочий цвет (desired), затем наша
           последняя запись (applied), иначе читаем состояние из OpenRGB.
           Приоритет desired важен после переподключения: там applied пуст,
           а actual LED может ещё помнить жёлтый */
        const desiredMap = this.desired.get(deviceId);
        const desiredColor = desiredMap ? desiredMap.get(ledIndex) : null;
        const applied = this.applied.get(deviceId);
        const before = desiredColor
            ? { ...desiredColor }
            : ((applied && applied.get(ledIndex))
                ? { ...applied.get(ledIndex) }
                : await this.readLedColor(client, deviceId, ledIndex));

        try {
            client.updateSingleLed(deviceId, ledIndex, HIGHLIGHT_COLOR);
        } catch (err) {
            this.handleDead(err, client);
            return;
        }

        this.highlighted.set(`${deviceId}:${ledIndex}`, { deviceId, ledIndex, before });
        log('OpenRGB', `Подсветка: LED ${ledIndex} на «${info.name}» (исходный ${before ? rgbStr(before) : 'неизвестен'})`);
    }

    /* Восстановить исходный цвет подсвеченного LED */
    async restoreHighlighted(key) {
        const entry = this.highlighted.get(key);
        if (!entry) return;
        this.highlighted.delete(key);

        const { deviceId, ledIndex, before } = entry;
        const applied = this.appliedFor(deviceId);
        applied.delete(ledIndex);

        const desiredMap = this.desired.get(deviceId);
        const desiredColor = desiredMap ? desiredMap.get(ledIndex) : null;
        /* Приоритет: текущий рабочий цвет → что горело до подсветки → чёрный */
        const restore = desiredColor || before || LED_OFF;

        const client = this.client;
        if (!client || !client.isConnected) return;

        try {
            client.updateSingleLed(deviceId, ledIndex, restore);
            applied.set(ledIndex, restore);
            log('OpenRGB', `Подсветка выключена: LED ${ledIndex} → ${rgbStr(restore)}`);
        } catch (err) {
            this.handleDead(err, client);
        }
    }

    /* Актуальный цвет LED из OpenRGB (для запоминания «до подсветки») */
    async readLedColor(client, deviceId, ledIndex) {
        try {
            const device = await client.getControllerData(deviceId);
            const c = device.colors && device.colors[ledIndex];
            if (c && ['red', 'green', 'blue'].every((k) => Number.isInteger(c[k]))) {
                return { red: c.red, green: c.green, blue: c.blue };
            }
        } catch (err) {
            /* не критично — восстановим через desired/чёрный */
        }
        return null;
    }

    appliedFor(deviceId) {
        let applied = this.applied.get(deviceId);
        if (!applied) {
            applied = new Map();
            this.applied.set(deviceId, applied);
        }
        return applied;
    }

    connect() {
        if (this.stopped) return Promise.resolve();
        if (this.client && this.client.isConnected) return Promise.resolve();
        if (this.connectTask) return this.connectTask;

        let done;
        this.connectTask = new Promise((resolve) => { done = resolve; });
        this.doConnect().finally(() => {
            this.connectTask = null;
            done();
        });
        return this.connectTask;
    }

    async doConnect() {
        let client = null;
        try {
            client = new OpenRGB.Client('DiscordAppOpenRGB', config.OPENRGB_PORT, config.OPENRGB_HOST);
            client.on('error', (err) => this.handleDead(err, client));
            client.on('disconnect', () => this.handleDead(new Error('сервер закрыл соединение'), client));

            await client.connect(CONNECT_TIMEOUT);

            this.client = client;
            this.deviceInfo.clear();
            this.warnedLeds.clear();
            /* Принудительно пере-применяем желаемые цвета */
            this.applied.clear();

            log('OpenRGB', 'Подключено к OpenRGB SDK.');
            this.emit('status', this.getStatus());
            await this.printAvailableDevices();
            this.scheduleFlush();
            /* Режим подсветки остался включён — зажигаем заново */
            if (this.highlightOn) {
                this.refreshHighlight().catch((err) => error('OpenRGB', `Подсветка: ${err.message}`));
            }
        } catch (err) {
            if (client) {
                if (this.client === client) {
                    this.dropClient();
                } else {
                    try { client.disconnect(); } catch (e) { /* ignore */ }
                }
            }
            error('OpenRGB', `Ошибка подключения: ${err.message}. Повтор через ${config.RECONNECT_INTERVAL / 1000} с.`);
            this.scheduleReconnect();
        }
    }

    /* Гарантированно дождаться подключения (для страницы настроек) */
    async ensureConnected() {
        if (this.client && this.client.isConnected) return true;
        await this.connect();
        return !!(this.client && this.client.isConnected);
    }

    /* Переподключиться заново (при смене host/port в настройках) */
    async reconnectNow() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.dropClient();
        await this.connect();
    }

    /* Список устройств OpenRGB для страницы настроек */
    async getDevices() {
        if (!(await this.ensureConnected())) {
            throw new Error('OpenRGB не подключён');
        }

        const count = await this.client.getControllerCount();
        const devices = [];
        for (let i = 0; i < count; i++) {
            const info = await this.getDeviceInfo(this.client, i);
            devices.push({ id: i, name: info.name, ledCount: info.ledCount });
        }
        return devices;
    }

    /* Разовая проверка LED (кнопка «Моргнуть») — минуя desired-state */
    async testLed(deviceId, ledIndex, color) {
        if (!(await this.ensureConnected())) {
            throw new Error('OpenRGB не подключён');
        }

        const info = await this.getDeviceInfo(this.client, deviceId);
        if (!info) {
            const err = new Error(`Устройство ${deviceId} не найдено`);
            err.status = 400;
            throw err;
        }
        if (ledIndex >= info.ledCount) {
            const err = new Error(`Индекс ${ledIndex} вне диапазона: у «${info.name}» ${info.ledCount} LED`);
            err.status = 400;
            throw err;
        }

        this.client.updateSingleLed(deviceId, ledIndex, color);
        return info;
    }

    handleDead(err, client) {
        if (client !== this.client) return;

        error('OpenRGB', `Соединение потеряно: ${err.message}`);
        this.dropClient();
        this.emit('status', this.getStatus());
        this.scheduleReconnect();
    }

    dropClient() {
        const client = this.client;
        this.client = null;
        this.deviceInfo.clear();
        this.applied.clear();
        /* Подсветка обрывается вместе с соединением; режим остаётся
           включённым — после переподключения цвета применятся заново */
        this.highlighted.clear();

        if (client) {
            try { client.disconnect(); } catch (e) { /* ignore */ }
        }
    }

    scheduleReconnect() {
        if (this.stopped || this.reconnectTimer || this.connectTask) return;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, config.RECONNECT_INTERVAL);
    }

    scheduleFlush() {
        if (this.flushScheduled || this.stopped) return;

        this.flushScheduled = true;
        setImmediate(() => {
            this.flushScheduled = false;
            this.flush().catch((err) => error('OpenRGB', `Ошибка записи LED: ${err.message}`));
        });
    }

    async flush() {
        const client = this.client;
        if (!client || !client.isConnected) return;

        for (const [deviceId, ledMap] of this.desired) {
            let info;
            try {
                info = await this.getDeviceInfo(client, deviceId);
            } catch (err) {
                this.handleDead(err, client);
                return;
            }

            if (!info) continue;

            let applied = this.applied.get(deviceId);
            if (!applied) {
                applied = new Map();
                this.applied.set(deviceId, applied);
            }

            const written = [];
            for (const [ledIndex, color] of ledMap) {
                /* LED подсвечен — не трогаем его, пока горит подсветка */
                if (this.highlighted.has(`${deviceId}:${ledIndex}`)) {
                    continue;
                }

                if (ledIndex >= info.ledCount) {
                    const key = `${deviceId}:${ledIndex}`;
                    if (!this.warnedLeds.has(key)) {
                        this.warnedLeds.add(key);
                        error('OpenRGB', `Устройство «${info.name}» имеет ${info.ledCount} LED — индекс ${ledIndex} недоступен, пропускаю.`);
                    }
                    continue;
                }

                /* Цвет уже в нужном состоянии — сокет не трогаем */
                const prev = applied.get(ledIndex);
                if (prev && prev.red === color.red && prev.green === color.green && prev.blue === color.blue) {
                    continue;
                }

                try {
                    client.updateSingleLed(deviceId, ledIndex, color);
                    applied.set(ledIndex, color);
                    written.push(ledIndex);
                } catch (err) {
                    this.handleDead(err, client);
                    return;
                }
            }

            if (written.length) {
                log('OpenRGB', `LED [${written.join(', ')}] на «${info.name}» обновлены.`);
            }
        }
    }

    async getDeviceInfo(client, deviceId) {
        const cached = this.deviceInfo.get(deviceId);
        if (cached) return cached;

        const device = await client.getControllerData(deviceId);
        const info = {
            name: device.name,
            ledCount: device.colors ? device.colors.length : 0
        };
        this.deviceInfo.set(deviceId, info);
        return info;
    }

    async printAvailableDevices() {
        try {
            const count = await this.client.getControllerCount();
            const markerId = settingsStore.getSettings().device.keyboardDeviceId;
            log('OpenRGB', 'Список доступных устройств:');
            for (let i = 0; i < count; i++) {
                const info = await this.getDeviceInfo(this.client, i);
                const marker = i === markerId ? '->' : '  ';
                log('OpenRGB', `${marker} id: ${i} name: ${info.name} (${info.ledCount} LED)`);
            }
        } catch (err) {
            error('OpenRGB', `Не удалось получить список устройств: ${err.message}`);
        }
    }
}

module.exports = { OpenRGBManager };
