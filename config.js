require('dotenv').config({ path: './secrets.env' });
const path = require('path');

module.exports = {
  CLIENT_ID: process.env.CLIENT_ID,
  CLIENT_SECRET: process.env.CLIENT_SECRET,

  REDIRECT_URI: 'http://localhost:3000',
  AUTH_SERVER_PORT: 3000,
  TOKEN_FILE: path.join(__dirname, 'discord_token.json'),

  RECONNECT_INTERVAL: 5000,

  OPENRGB_HOST: 'localhost',
  OPENRGB_PORT: 6742,

  KEYBOARD_DEVICE_ID: 0,
  MIC_CONTROL_LED_INDEX: 15,
  SOUND_CONTROL_LED_INDEX: 14,

  LED_COLORS: {
    ON: { red: 0, green: 255, blue: 0 },
    OFF: { red: 255, green: 0, blue: 0 }
  }
};