/*---------------------------------------------------------*\
| discordRpc.js                                             |
|                                                           |
|   Сессия Discord RPC (handshake, auth, подписки)          |
|   и супервизор переподключений:                           |
|   - новый экземпляр сессии на каждую попытку              |
|   - таймауты на всех шагах                                |
|   - backoff 5с -> 10с -> 20с -> 40с -> 60с                |
|     (лимит Discord: 2 подключения в минуту)               |
|   - повторная авторизация через refresh-токен             |
|     при отказе AUTHENTICATE                               |
\*---------------------------------------------------------*/

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { log, error } = require('./logger');
const config = require('./config');
const settingsStore = require('./settings');
const { DiscordIpc, OP } = require('./discordIpc');

const REQUEST_TIMEOUT = 10000;
const READY_TIMEOUT = 10000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Текущее состояние Discord-сессии — читается страницей настроек */
const rpcStatus = {
    connected: false,
    micMuted: null,
    deaf: null,
    scopes: [],
    lastError: null
};

function getRpcStatus() {
    return { ...rpcStatus };
}

/* Функция пере-применения текущего голосового состояния
   (устанавливается супервизором на время активной сессии) */
let reapplyFn = null;

function reapplyCurrentState() {
    if (reapplyFn) reapplyFn();
}

/* Ошибка авторизации: нужен свежий токен (refresh или повторный вход) */
class AuthError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'AuthError';
        this.isAuthError = true;
        this.code = code;
    }
}

class DiscordRpcSession extends EventEmitter {
    constructor(clientId, accessToken) {
        super();
        this.clientId = clientId;
        this.accessToken = accessToken;
        this.ipc = new DiscordIpc(clientId);
        this.pending = new Map();
        this.ready = null;
        this.disconnectReason = null;
        this.scopes = [];
    }

    async start() {
        this.ipc.on('packet', (packet) => this.onFrame(packet));
        this.ipc.on('close', (err) => this.onClose(err));

        await this.ipc.connect(3000);

        const readyPromise = this.waitForReady(READY_TIMEOUT);
        this.ipc.send(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
        await readyPromise;

        const auth = await this.request('AUTHENTICATE', { access_token: this.accessToken }, true);
        this.scopes = (auth && auth.scopes) || [];

        if (!this.scopes.includes('rpc') && !this.scopes.includes('rpc.voice.read')) {
            throw new AuthError(`нет scope rpc.voice.read (выдано: ${this.scopes.join(', ') || 'ничего'})`);
        }

        await this.request('SUBSCRIBE', {}, false, 'VOICE_SETTINGS_UPDATE');
        log('DiscordRPC', 'Подписка на обновления голосовых настроек выполнена.');
    }

    getVoiceSettings() {
        return this.request('GET_VOICE_SETTINGS', {});
    }

    waitForReady(timeout) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.ready = null;
                reject(new Error('Discord IPC: таймаут READY'));
            }, timeout);

            this.ready = {
                resolve: (value) => {
                    clearTimeout(timer);
                    this.ready = null;
                    resolve(value);
                },
                reject: (reason) => {
                    clearTimeout(timer);
                    this.ready = null;
                    reject(reason);
                }
            };
        });
    }

    request(cmd, args = {}, isAuth = false, evt) {
        return new Promise((resolve, reject) => {
            if (!this.ipc.connected) {
                reject(new Error('Discord IPC: не подключено'));
                return;
            }

            const nonce = crypto.randomUUID();
            const entry = {
                cmd,
                isAuth,
                resolve: (value) => {
                    clearTimeout(entry.timer);
                    this.pending.delete(nonce);
                    resolve(value);
                },
                reject: (reason) => {
                    clearTimeout(entry.timer);
                    this.pending.delete(nonce);
                    reject(reason);
                }
            };

            entry.timer = setTimeout(() => {
                entry.reject(new Error(`Discord RPC: таймаут команды ${cmd}`));
            }, REQUEST_TIMEOUT);

            this.pending.set(nonce, entry);

            const payload = { cmd, args, nonce };
            if (evt) payload.evt = evt;

            try {
                this.ipc.send(OP.FRAME, payload);
            } catch (err) {
                entry.reject(err);
            }
        });
    }

    settle(nonce, data, rpcError) {
        const entry = this.pending.get(nonce);
        if (!entry) return;

        if (rpcError) {
            const err = entry.isAuth
                ? new AuthError(rpcError.message, rpcError.code)
                : new Error(rpcError.message);
            err.code = rpcError.code;
            entry.reject(err);
            return;
        }

        entry.resolve(data);
    }

    onFrame(packet) {
        if (!packet) return;

        /* Ответ-ошибка */
        if (packet.evt === 'ERROR') {
            const data = packet.data || {};
            this.settle(packet.nonce, null, { message: data.message || 'RPC ошибка', code: data.code });
            return;
        }

        /* Ответ на команду */
        if (packet.nonce && this.pending.has(packet.nonce)) {
            this.settle(packet.nonce, packet.data, null);
            return;
        }

        /* События */
        if (packet.cmd === 'DISPATCH') {
            if (packet.evt === 'READY') {
                if (this.ready) this.ready.resolve(packet.data);
                return;
            }

            if (packet.evt === 'VOICE_SETTINGS_UPDATE') {
                this.emit('voiceSettingsUpdate', packet.data);
                return;
            }

            this.emit('dispatch', packet.evt, packet.data);
        }
    }

    onClose(err) {
        this.disconnectReason = err;

        if (this.ready) {
            this.ready.reject(err);
        }

        for (const entry of Array.from(this.pending.values())) {
            entry.reject(err);
        }

        this.emit('disconnected', err);
    }

    waitDisconnected() {
        if (this.disconnectReason) return Promise.resolve(this.disconnectReason);
        return new Promise((resolve) => this.once('disconnected', resolve));
    }

    destroy() {
        this.ipc.removeAllListeners();
        this.ipc.close();

        if (this.ready) {
            this.ready.reject(new Error('сессия закрыта'));
        }

        for (const entry of Array.from(this.pending.values())) {
            entry.reject(new Error('сессия закрыта'));
        }

        this.removeAllListeners();
    }
}

/*
* Главный цикл: подключаемся -> слушаем мьют -> при обрыве переподключаемся.
* getAccessToken({ refresh }) вызывается на каждой итерации: при isAuth-ошибке
* запрашиваем именно обновление токена, иначе просто читаем валидный.
*/
async function startRpc(getAccessToken, rgb) {
    const FIRST_RETRY = 5000;
    const MAX_RETRY = 60000;

    let retryDelay = FIRST_RETRY;
    let forceRefresh = false;

    while (true) {
        let session = null;
        let onSettingsChanged = null;

        try {
            const accessToken = await getAccessToken({ refresh: forceRefresh });
            forceRefresh = false;

            session = new DiscordRpcSession(config.CLIENT_ID, accessToken);
            await session.start();
            retryDelay = FIRST_RETRY;

            log('DiscordRPC', 'Подключено к Discord RPC.');

            let lastState = null;

            const applyState = (voiceSettings, force) => {
                const micMuted = !!(voiceSettings && voiceSettings.mute);
                const soundDeaf = !!(voiceSettings && voiceSettings.deaf);

                /* Настройки читаем на каждый вызов — изменения применяются
                   сразу, без перезапуска приложения */
                const s = settingsStore.getSettings();

                /* Пишем в LED только то, что реально изменилось */
                const changed = [];
                if (force || !lastState || lastState.mic !== micMuted) {
                    changed.push([s.device.micLedIndex, micMuted ? s.colors.micMuted : s.colors.micUnmuted]);
                }
                if (force || !lastState || lastState.sound !== soundDeaf) {
                    changed.push([s.device.soundLedIndex, soundDeaf ? s.colors.soundDeaf : s.colors.soundUndeaf]);
                }

                lastState = { mic: micMuted, sound: soundDeaf };
                rpcStatus.micMuted = micMuted;
                rpcStatus.deaf = soundDeaf;

                if (changed.length) rgb.setLedColors(s.device.keyboardDeviceId, changed);
            };

            applyState(await session.getVoiceSettings(), true);

            /* Новые настройки (цвета/индексы) применяем сразу и целиком */
            reapplyFn = () => { if (lastState) applyState(lastState, true); };
            onSettingsChanged = () => {
                try {
                    reapplyCurrentState();
                } catch (err) {
                    error('DiscordRPC', `Не удалось применить новые настройки: ${err.message}`);
                }
            };
            settingsStore.onChange(onSettingsChanged);

            rpcStatus.connected = true;
            rpcStatus.scopes = session.scopes.slice();
            rpcStatus.lastError = null;

            session.on('voiceSettingsUpdate', (settings) => {
                try {
                    applyState(settings, false);
                } catch (err) {
                    error('DiscordRPC', `Ошибка обработки голосовых настроек: ${err.message}`);
                }
            });

            await session.waitDisconnected();
            error('DiscordRPC', 'Соединение с Discord потеряно, переподключение...');
        } catch (err) {
            if (err && err.isAuthError) {
                forceRefresh = true;
                error('DiscordRPC', `Ошибка авторизации: ${err.message}. Попробую обновить токен.`);
            } else {
                error('DiscordRPC', `Ошибка: ${err.message}`);
            }
            rpcStatus.lastError = err.message;
        } finally {
            rpcStatus.connected = false;
            reapplyFn = null;
            if (onSettingsChanged) settingsStore.offChange(onSettingsChanged);
            if (session) session.destroy();
        }

        await sleep(retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY);
    }
}

module.exports = { startRpc, DiscordRpcSession, AuthError, getRpcStatus, reapplyCurrentState };
