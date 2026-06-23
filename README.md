# Ping Pong Streams Overlay

HTML/CSS/JS-оверлей счета для IRL-стрима через Moblin Browser widget. PNG `scoreboard_transparent.png` лежит в проекте только как визуальный референс. Оверлей сверстан живыми HTML-элементами: счет, таймер, сеты и индикаторы подачи обновляются через JavaScript.

## Файлы

- `overlay.html` - прозрачный read-only оверлей для Moblin.
- `control.html` - панель управления с Firebase Auth.
- `style.css` - стили оверлея и панели управления.
- `script.js` - логика счета, таймера, подачи, BO3/BO5, автозавершения, Undo, Firebase и локального fallback.
- `firebase-config.js` - Firebase config и путь в Realtime Database.
- `scoreboard_transparent.png` - визуальный референс, не используется как фон.

## Firebase Path

Текущее состояние матча хранится строго по пути:

```js
scoreboard/current
```

Путь задан в `firebase-config.js`:

```js
window.scoreboardDatabasePath = "scoreboard/current";
```

Не переносите рабочую базу на `matches/default`, если проект уже настроен на `scoreboard/current`.

## Firebase Authentication

Для публичной публикации `control.html` должен писать в Firebase только после входа администратора.

1. В Firebase Console открой `Authentication -> Sign-in method`.
2. Включи провайдер `Email/Password`.
3. В `Authentication -> Users` создай пользователей для управления счетом.
4. Скопируй UID каждого пользователя.
5. В Realtime Database добавь UID в корневую ветку `admins` со значением `true`.

Ожидаемая структура базы:

```text
admins
├─ UID_1: true
├─ UID_2: true
└─ UID_3: true

scoreboard
└─ current
```

`overlay.html` не показывает форму входа и не пишет в базу. Он только читает `scoreboard/current` и отображает состояние.

`control.html` показывает блок входа. После Email/Password-входа код проверяет `admins/<uid>`. Если там `true`, кнопки управления включаются. Если UID отсутствует или значение не `true`, кнопки остаются заблокированными.

## Realtime Database Rules

Используй правила под текущую структуру базы:

```json
{
  "rules": {
    "scoreboard": {
      "current": {
        ".read": true,
        ".write": "auth != null && root.child('admins').child(auth.uid).val() === true"
      }
    },
    "admins": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": false
      }
    }
  }
}
```

Смысл правил простой: overlay читает счет без входа, а запись в `scoreboard/current` разрешена только авторизованным UID из `admins`.

## Локальный запуск

Для Firebase Auth открывай проект через локальный HTTP-сервер. Не открывай `control.html` и `overlay.html` через `file://` или двойным кликом.

Из папки проекта:

```bash
python -m http.server 8000
```

Открой:

```text
http://localhost:8000/control.html?v=1
http://localhost:8000/overlay.html?v=1
```

Параметр `?v=1` помогает обойти кэш браузера после правок. При следующей проверке можно менять на `?v=2`, `?v=3` и так далее.

## Проверка Без Входа

1. Открой `overlay.html` через `http://localhost:8000/overlay.html?v=1`.
2. Убедись, что overlay не показывает форму входа.
3. Убедись, что overlay показывает текущее состояние `scoreboard/current`.
4. Открой `control.html` через `http://localhost:8000/control.html?v=1`.
5. Убедись, что виден блок авторизации.
6. Статус должен быть `Не авторизован`.
7. Кнопки управления должны быть disabled.
8. Нажатия на управляющие кнопки без входа не должны менять счет.

## Проверка После Входа Админа

1. В `control.html` введи email/password пользователя из Firebase Authentication.
2. Нажми `Войти`.
3. Если UID есть в `admins/<uid>: true`, статус станет `Вы вошли как: email`.
4. Кнопки управления станут активными.
5. Проверь `+1 левая`, `+1 правая`, таймер, Undo, BO3/BO5.
6. Открой overlay во второй вкладке и убедись, что изменения приходят сразу.

## Проверка Пользователя Без Прав

1. Войди пользователем, UID которого нет в `admins`.
2. Статус должен быть `Нет прав администратора`.
3. Кнопки управления должны остаться disabled.
4. Запись должна быть запрещена и клиентом, и Firebase Rules.

## Проверка Выхода

1. Нажми `Выйти`.
2. Статус должен вернуться к `Не авторизован`.
3. Кнопки управления снова должны стать disabled.
4. Счет в readout можно видеть, но менять его нельзя.

## Проверка Матчевой Логики

После входа админа проверь основные сценарии:

- BO3: `11:9` сначала виден примерно 2 секунды, затем `sets 1:0`, `СЕТ 2`, `points 0:0`, timer `00:00`.
- BO3: `11:10` не завершает сет.
- BO3: `12:10` завершает сет.
- BO3: при сетах `1:1` следующий выигранный сет завершает матч `2:1` и не включает `СЕТ 4`.
- BO5: при сетах `2:2` следующий выигранный сет завершает матч `3:2` или `2:3` и не включает `СЕТ 6`.
- Deuce: при `10:10` подача отображается по одной.
- Undo во время 2-секундной задержки отменяет pending-переход.
- Undo после автоперехода откатывает весь автоматический переход целиком.

## Overlay Read-Only Проверка

Открой одновременно:

```text
http://localhost:8000/overlay.html?v=1
http://localhost:8000/overlay.html?v=2
http://localhost:8000/control.html?v=1
```

Заверши сет через `control.html`. Автоматическое завершение должно сработать один раз. Несколько открытых overlay не должны добавлять сеты, запускать Undo, сброс или любые write-операции.

## GitHub Pages

После локальной проверки:

1. Залей файлы в GitHub repository.
2. В настройках репозитория открой `Settings -> Pages`.
3. Выбери ветку и папку, где лежат файлы.
4. Открой опубликованные URL:

```text
https://USER.github.io/REPO/control.html?v=1
https://USER.github.io/REPO/overlay.html?v=1
```

5. Войди в `control.html` через Email/Password.
6. Проверь, что админ может менять счет, а overlay получает изменения.
7. URL `overlay.html` вставляй в Moblin Browser widget.

Если после публикации кнопки не активируются, проверь три вещи: включен ли Email/Password Auth, добавлен ли UID в `admins`, и стоят ли правила Realtime Database под `scoreboard/current`.