const { log, error } = require('./logger');
const config = require('./config');
const { RPClient, RPCEvent } = require('@corwinjs/rpcord');
const { setKeyColor } = require('./openRGBController');

async function startRpc(token, openRGBClient) {
    const rpc = new RPClient(config.CLIENT_ID, { scopes: ['rpc', 'rpc.voice.read'] });

    rpc.on('ready', () => log('DiscordRPC', 'Подключено к Discord RPC.'));
    rpc.on('error', (err) => error('DiscordRPC', err.message));

    while (true) {
        try {
            await rpc.connect();
            break;
        } catch (err) {
            error('DiscordRPC', `Ошибка подключения: ${err.message}`);
            await new Promise((r) => setTimeout(r, config.RECONNECT_INTERVAL));
        }
    }

    await rpc.authenticate(token);

    const updateLED = async (voiceSettings) => {
        const micColor = voiceSettings.mute ? config.LED_COLORS.ON : config.LED_COLORS.OFF;
        const soundColor = voiceSettings.deaf ? config.LED_COLORS.ON : config.LED_COLORS.OFF;
        await setKeyColor(openRGBClient, config.KEYBOARD_DEVICE_ID, [
            [config.MIC_CONTROL_LED_INDEX, micColor],
            [config.SOUND_CONTROL_LED_INDEX, soundColor]
        ]);
    };

    const settings = await rpc.getVoiceSettings();
    await updateLED(settings);

    rpc.subscribe(RPCEvent.VoiceSettingsUpdate);
    rpc.on('voiceSettingsUpdate', updateLED);

    log('DiscordRPC', 'Подписка на обновления голосовых настроек выполнена.');
}

module.exports = { startRpc };