/*---------------------------------------------------------*\
| discordIpc.js                                             |
|                                                           |
|   Транспорт Discord RPC поверх named pipe (IPC)           |
|   Замена @corwinjs/rpcord:                                |
|   - корректная сборка фреймов (буфер не теряет данные,    |
|     если пакет пришёл кусками или несколькими сразу)      |
|   - попытки подключения к discord-ipc-0..9 с таймаутом    |
|   - обработка обрыва и ошибок сокета                      |
\*---------------------------------------------------------*/

const net = require('net');
const { EventEmitter } = require('events');
const config = require('./config');

const OP = {
    HANDSHAKE: 0,
    FRAME: 1,
    CLOSE: 2,
    PING: 3,
    PONG: 4
};

const PIPE_PREFIX = '\\\\.\\pipe\\discord-ipc-';
const MAX_PAYLOAD = 16 * 1024 * 1024; // защита от битого заголовка

class DiscordIpc extends EventEmitter {
    constructor(clientId) {
        super();
        this.clientId = clientId;
        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.connected = false;
        this.closed = false;
    }

    /* Подключается к первому доступному пайпу Discord */
    connect(pipeTimeout = 3000) {
        /* Явно заданный пайп (DISCORD_PIPE) или стандартный перебор 0..9 */
        const pipes = config.DISCORD_PIPE
            ? [config.DISCORD_PIPE.startsWith('\\\\') ? config.DISCORD_PIPE : '\\\\.\\pipe\\' + config.DISCORD_PIPE]
            : Array.from({ length: 10 }, (_, i) => PIPE_PREFIX + i);

        return new Promise((resolve, reject) => {
            let pipeIndex = 0;
            let settled = false;

            const fail = (err) => {
                if (settled) return;
                settled = true;
                reject(err);
            };

            const tryNext = () => {
                if (settled) return;
                if (this.closed) return fail(new Error('Discord IPC: клиент закрыт'));
                if (pipeIndex >= pipes.length) {
                    return fail(new Error(`Discord IPC: пайпы не найдены (${pipes.join(', ')}) — Discord запущен?`));
                }

                const socket = net.createConnection(pipes[pipeIndex]);

                const timer = setTimeout(() => {
                    socket.destroy();
                    pipeIndex += 1;
                    if (!settled) tryNext();
                }, pipeTimeout);

                socket.on('error', (err) => {
                    clearTimeout(timer);
                    if (settled) {
                        /* Ошибка уже установленного соединения */
                        this.handleClose(err);
                        return;
                    }
                    /* Пайп занят/не существует — пробуем следующий */
                    socket.destroy();
                    pipeIndex += 1;
                    tryNext();
                });

                socket.once('connect', () => {
                    clearTimeout(timer);
                    if (settled) {
                        socket.destroy();
                        return;
                    }
                    settled = true;
                    this.attach(socket);
                    resolve();
                });
            };

            tryNext();
        });
    }

    attach(socket) {
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.connected = true;

        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('close', () => this.handleClose(new Error('Discord IPC: соединение закрыто')));
    }

    handleClose(err) {
        if (!this.connected) return;
        this.connected = false;

        const socket = this.socket;
        this.socket = null;
        if (socket) {
            try { socket.destroy(); } catch (e) { /* ignore */ }
        }

        this.emit('close', err || new Error('Discord IPC: соединение закрыто'));
    }

    send(op, data) {
        if (!this.connected || !this.socket) {
            throw new Error('Discord IPC: не подключено');
        }

        const json = Buffer.from(JSON.stringify(data), 'utf8');
        const header = Buffer.alloc(8);
        header.writeInt32LE(op, 0);
        header.writeInt32LE(json.length, 4);

        this.socket.write(Buffer.concat([header, json]));
    }

    onData(chunk) {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

        while (this.buffer.length >= 8) {
            const op = this.buffer.readInt32LE(0);
            const length = this.buffer.readInt32LE(4);

            if (length < 0 || length > MAX_PAYLOAD) {
                this.handleClose(new Error('Discord IPC: повреждённый заголовок пакета'));
                return;
            }

            /* Пакет ещё не дочитан — ждём следующий кусок данных */
            if (this.buffer.length < 8 + length) break;

            const payload = this.buffer.subarray(8, 8 + length);
            this.buffer = this.buffer.subarray(8 + length);

            let data;
            try {
                data = JSON.parse(payload.toString('utf8'));
            } catch (err) {
                continue;
            }

            if (op === OP.PING) {
                try { this.send(OP.PONG, data); } catch (e) { /* ignore */ }
                continue;
            }

            if (op === OP.CLOSE) {
                this.handleClose(new Error(`Discord IPC закрыл соединение: ${data.code} ${data.message || ''}`));
                return;
            }

            if (op === OP.FRAME) {
                this.emit('packet', data);
            }
        }
    }

    close() {
        this.closed = true;
        this.connected = false;

        const socket = this.socket;
        this.socket = null;
        if (socket) {
            try { socket.end(); } catch (e) { /* ignore */ }
            try { socket.destroy(); } catch (e) { /* ignore */ }
        }
    }
}

module.exports = { DiscordIpc, OP };
