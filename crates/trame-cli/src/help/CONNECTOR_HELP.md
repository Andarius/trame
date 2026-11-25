tramecli connector — where Trame sends messages (Telegram today)

  tramecli connector setup <name> [--chat-id ID]   ask for the values, check them, send a test
  tramecli connector list                          known connectors, set up or not (secrets masked)
  tramecli connector test [name…]                  send "Trame test" through one or every set-up connector
  tramecli connector rm <name>                     forget a connector's values

Values live in ~/.config/trame/connectors.env (mode 600; TRAME_CONNECTORS_ENV
overrides the path); the process environment wins over the file. Secrets are
read without echo; pipe them on stdin to script the setup.

telegram   TELEGRAM_BOT_TOKEN (from @BotFather) and TELEGRAM_CHAT_ID. Send /start
           to the bot first: setup checks the token with getMe and takes the chat
           id from your last private message (or --chat-id).

`tramecli due --send` sends through every set-up connector unless --to names some.
