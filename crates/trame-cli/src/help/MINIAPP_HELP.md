Usage: tramecli miniapp serve [--addr HOST:PORT]

Serve a read-only Telegram Mini App listing the late and next-7-days due todos.
Default address 0.0.0.0:8790; routes: GET /tg/ (page), POST /tg/api/due (JSON).

Requests must carry Telegram initData (header X-Telegram-Init-Data), signed with
the bot token, at most 24 h old, from the user TELEGRAM_CHAT_ID; anything else is
a 401. Token and chat id come from `tramecli connector setup telegram` (or env);
the server refuses to start without them. Todos are read like `tramecli due`
(local app, else the hub).

Put it behind HTTPS (hub/miniapp/) and point the bot's menu button at /tg/.
