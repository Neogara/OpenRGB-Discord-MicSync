/*---------------------------------------------------------*\
| auth-success.js                                            |
|                                                           |
|   Страница результата авторизации Discord:                |
|   - анимация «подключаемся к серверам Discord»             |
|   - чек-лист: токен сохранён -> подключение -> готово      |
|   - опрос /api/status каждые 500 мс до discord.connected   |
|     (таймаут 15 с), честные состояния шагов                |
|   - кнопки: «Перейти в настройки» и «Закрыть страницу»     |
|   - вариант ошибки: ?error=1[&msg=...]                     |
|   - window.__AUTH_INLINE__ — страницу отдал сам            |
|     auth-сервер (порт настроек занят), опрос не нужен      |
\*---------------------------------------------------------*/
(function () {
    'use strict';

    var POLL_MS = 500;
    var TIMEOUT_MS = 15000;
    var CLOSE_FALLBACK_MS = 300;

    var params = new URLSearchParams(window.location.search);
    var inline = window.__AUTH_INLINE__ || null;

    var isError = params.get('error') === '1' || !!(inline && inline.error);
    var msg = params.get('msg') || (inline && inline.msg) || '';
    var inlinePort = inline && inline.port ? inline.port : null;

    var orb = document.getElementById('orb');
    var title = document.getElementById('auth-title');
    var badge = document.getElementById('badge-state');
    var note = document.getElementById('note');
    var stepToken = document.getElementById('step-token');
    var stepDiscord = document.getElementById('step-discord');
    var stepDone = document.getElementById('step-done');
    var btnSettings = document.getElementById('btn-settings');
    var btnClose = document.getElementById('btn-close');
    var closeHint = document.getElementById('close-hint');

    function setStep(el, state, text) {
        el.className = 'step ' + state;
        if (text) {
            el.lastChild.textContent = text;
        }
    }

    /* --- кнопки --- */
    btnSettings.addEventListener('click', function () {
        /* в обычном режиме страница уже на порту настроек — относительный
           путь; при отданном auth-сервером HTML — прямой адрес */
        window.location.href = inlinePort ? 'http://127.0.0.1:' + inlinePort + '/' : '/';
    });

    btnClose.addEventListener('click', function () {
        window.close();
        /* Браузер может запретить закрытие вкладки, открытой редиректом —
           через короткую паузу честно подсказываем, как закрыть вручную */
        setTimeout(function () {
            if (!window.closed) closeHint.classList.remove('hidden');
        }, CLOSE_FALLBACK_MS);
    });

    /* --- вариант ошибки --- */
    if (isError) {
        orb.classList.add('fail');
        title.textContent = 'Авторизация не завершена';
        badge.textContent = 'Discord: ошибка';
        badge.className = 'badge badge-bad';
        setStep(stepToken, 'fail', 'Токен не сохранён');
        setStep(stepDiscord, 'fail', 'Подключение не выполнялось');
        setStep(stepDone, 'fail', 'Не выполнено');
        note.className = 'hint error';
        note.textContent = msg || 'Discord не выдал код авторизации. Попробуйте ещё раз.';
        return;
    }

    /* --- страница отдана самим auth-сервером: страницы настроек нет,
           опрашивать нечего — честно сообщаем об этом --- */
    if (inline) {
        setStep(stepDiscord, 'warn', 'Страница настроек не запустилась — Discord подключится сам');
        setStep(stepDone, 'warn', 'Проверьте страницу настроек позже');
        note.className = 'hint';
        note.textContent = inlinePort
            ? 'Порт ' + inlinePort + ' занят — перезапустите приложение, чтобы открыть страницу настроек.'
            : 'Страница настроек не запустилась — перезапустите приложение.';
        badge.textContent = 'Discord: подключение…';
        return;
    }

    /* --- обычный режим: ждём подключения к Discord --- */
    var startedAt = Date.now();
    var timedOut = false;
    var timer = setInterval(function () {
        /* 15 с — честно сообщаем о задержке, но продолжаем опрос:
           позднее подключение всё равно обновит страницу */
        if (!timedOut && Date.now() - startedAt > TIMEOUT_MS) {
            timedOut = true;
            title.textContent = 'Discord пока не отвечает';
            setStep(stepDiscord, 'warn', 'Discord не ответил за 15 с — проверьте, что он запущен');
            setStep(stepDone, 'done', 'Токен сохранён, подключение продолжится в фоне');
            note.className = 'hint';
            note.textContent = 'Если Discord запущен, подключение произойдёт автоматически — страница обновится сама.';
        }

        fetch('/api/status', { cache: 'no-store' })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) {
                if (!data || !data.discord || !data.discord.connected) return;
                clearInterval(timer);
                orb.classList.add('ready');
                title.textContent = 'Подключено к Discord';
                badge.textContent = 'Discord: подключён';
                badge.className = 'badge badge-ok';
                setStep(stepDiscord, 'done', 'Discord подключён');
                setStep(stepDone, 'done', 'Готово — можно переходить к настройкам');
                note.className = 'hint';
                note.textContent = 'Мьют и звук теперь отслеживаются, цвета применятся к клавиатуре.';
            })
            .catch(function () { /* кратковременный сбой запроса — продолжаем */ });
    }, POLL_MS);
})();
