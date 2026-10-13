# 🎮 Discord Mic & Sound Status LED Sync with OpenRGB

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen)

Синхронизируй статус микрофона и звука из **Discord** прямо с подсветкой клавиатуры/девайсов через **OpenRGB SDK**!  
Когда микрофон или звук выключен — цвет меняется. Удобно, наглядно. 🚦🎤

---

## 📦 Возможности

- Подключение к Discord через **OAuth2 RPC API**
- Чтение статуса микрофона (mute) и звука (deaf)
- Подсветка определённых LED на клавиатуре через **OpenRGB**
- Индикация состояния:
  - **Зелёный** → выключено
  - **Красный** → включено
- Поддержка переподключений и обработки ошибок

---

## 🚀 Установка и запуск

### 1. Клонируй репозиторий

```bash
git clone https://github.com/Neogara/OpenRGB-Discord-MicSync.git
cd discord-mic-openrgb-sync
```

### 2. Установи зависимости

```bash
npm install
```

### 3. Настрой `.env`

Создай файл **`secrets.env`** в корне проекта:

```
CLIENT_ID=YOUR_DISCORD_CLIENT_ID
CLIENT_SECRET=YOUR_DISCORD_CLIENT_SECRET
```

Как получить:

1. Перейди в [Discord Developer Portal](https://discord.com/developers/applications)
2. Создай приложение → OAuth2 → Redirect URI: `http://localhost:3000`
3. Добавь Scopes: `rpc`, `rpc.voice.read`

### 4. Настрой OpenRGB

- Включи **SDK Server** в настройках OpenRGB.
- Оставь хост `localhost` и порт `6742` (или измени в `config.js`).

### 5. Запуск

```bash
node main.js
```

В первый запуск откроется браузер для авторизации через Discord. После
подтверждения браузер попадёт на страницу результата (адрес страницы
настроек печатается в лог при старте): анимация «подключаемся к Discord»,
а затем кнопки **Перейти в настройки** и **Закрыть страницу**.

Все настройки (устройство, LED-индексы, цвета, порт страницы,
автозагрузка) — на странице настроек, адрес печатается в лог:

```
[WebUI] Страница настроек: http://127.0.0.1:3001
```

---

## ⚙️ Конфигурация

Пользовательские настройки (устройство, LED-индексы, цвета, порты,
автозагрузка) живут в **`settings.json`** и меняются на странице
настроек без правки файлов. В **`config.js`** — только константы
инфраструктуры:

| Параметр               | Описание                                      | Значение по умолчанию        |
|------------------------|-----------------------------------------------|------------------------------|
| CLIENT_ID, CLIENT_SECRET| Данные OAuth2 для Discord                    | из `secrets.env`             |
| REDIRECT_URI            | Redirect URL для OAuth2                       | `http://localhost:3000`      |
| OPENRGB_HOST, PORT      | Подключение к OpenRGB SDK                     | `localhost:6742`             |
| KEYBOARD_DEVICE_ID      | ID устройства OpenRGB                         | `0`                          |
| MIC_CONTROL_LED_INDEX   | Индекс LED для микрофона                      | `15`                         |
| SOUND_CONTROL_LED_INDEX | Индекс LED для звука                          | `14`                         |
| LED_COLORS              | Цвета для включено/выключено                  | Зелёный/Красный              |
| TOKEN_FILE              | Файл хранения Discord токена                  | `discord_token.json`         |

---

## 🛠️ Структура проекта

```
.
├── config.js              // Настройки
├── logger.js              // Логирование
├── tokenManager.js        // Работа с токенами Discord
├── openRGBController.js   // Подключение к OpenRGB
├── discordRpc.js          // Подключение к Discord RPC
├── main.js                // Основной запуск
├── secrets.env            // Твои ключи
└── discord_token.json     // Сохраняемый токен (автоматически создаётся)
```

---

## ❓ Часто задаваемые вопросы

### Можно ли изменить LED индексы и цвета?
Да! Все значения находятся в `config.js`. Можешь легко изменить:

```js
MIC_CONTROL_LED_INDEX: 10,
SOUND_CONTROL_LED_INDEX: 11,
LED_COLORS: {
  ON: { red: 0, green: 0, blue: 255 }, // Синий
  OFF: { red: 255, green: 255, blue: 0 }, // Жёлтый
}
```

---
