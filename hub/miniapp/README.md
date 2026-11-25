Read-only Telegram Mini App of due todos (`tramecli miniapp serve`), served at `/tg/`.

Run on linux-mini (needs `tramecli`, `connectors.env` with the bot token and chat id, hub settings):
`docker compose -f hub/miniapp/docker-compose.yml up -d`

Menu button (once, from the bot): `setChatMenuButton` with `menu_button` =
`{"type":"web_app","text":"Due","web_app":{"url":"https://trame.padowan.synology.me/tg/"}}`
(or BotFather: /setmenubutton).
