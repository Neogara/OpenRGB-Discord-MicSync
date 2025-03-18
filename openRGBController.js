const { error, log} = require('./logger');
const OpenRGB = require('openrgb-sdk');
const config = require('./config');

async function connectOpenRGB() {
  const client = new OpenRGB.Client('DiscordAppOpenRGB', { host: config.OPENRGB_HOST, port: config.OPENRGB_PORT });
  while (true) {
    try {
      await client.connect();
      log('OpenRGB', 'Подключено к OpenRGB SDK.');
      await printAvailableDevices(client);
      return client;
    } catch (err) {
      error('OpenRGB', `Ошибка подключения: ${err.message}`);
      await new Promise((r) => setTimeout(r, config.RECONNECT_INTERVAL));
    }
  }
}

async function printAvailableDevices(client) {
  const count = await client.getControllerCount();
  log('OpenRGB', 'Список доступных устройств:');
  for (let i = 0; i < count; i++) {
    const data = await client.getControllerData(i);
    console.log(`${i === config.KEYBOARD_DEVICE_ID ? '->' : '  '} id: ${data.deviceId} name: ${data.name} (${data.description})`);
  }
}

async function setKeyColor(client, deviceId, ledColors) {
  const device = await client.getControllerData(deviceId);
  if (!device.colors || device.colors.length === 0) return log('OpenRGB', `Устройство ${device.name} не имеет LED.`);
  for (const [ledIndex, color] of ledColors) {
    await client.updateSingleLed(deviceId, ledIndex, color);
    log('OpenRGB', `LED ${ledIndex} на ${device.name} установлен в [${color.red}, ${color.green}, ${color.blue}]`);
  }
}

module.exports = { connectOpenRGB, setKeyColor };