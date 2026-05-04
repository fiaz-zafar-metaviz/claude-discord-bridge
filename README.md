# claude-discord-bridge

Send Discord messages (text + voice) to Claude Code running on your project. Claude has full file/bash/edit access and replies back on Discord. Same conversation continues in terminal too.

No Anthropic API key required. Uses your existing Claude Code subscription via the local `claude` CLI.

## What it does

- You type or speak in a private Discord channel
- Bot detects your message, runs `claude -p` on your project
- Claude executes (read files, edit code, run commands, etc.) with full access
- Reply comes back on Discord
- Voice messages get transcribed locally via Whisper, then processed
- Same session UUID, so you can also `claude --resume <uuid>` from terminal to continue the chat

## Prerequisites

1. **Node.js 18+**
2. **Claude Code CLI** installed and logged in (`claude auth login`)
3. **Discord account** with a server you control
4. **Python 3.8+** (optional, only for voice messages)

## One-command setup

```powershell
# Windows
git clone https://github.com/fiaz-zafar-metaviz/claude-discord-bridge.git
cd claude-discord-bridge
.\setup.cmd
```

The setup script will walk you through:

1. Creating a Discord application + bot token
2. Inviting the bot to your server
3. Getting your User ID + Channel ID
4. Pointing it at your project folder

It also installs PM2, configures auto-startup (bot survives reboots and restarts on crash), and optionally installs `faster-whisper` for voice support.

## Manual setup (if you prefer)

```bash
cp .env.example .env
# Edit .env with your token, user ID, channel ID, project path
npm install
pip install faster-whisper  # optional, for voice
npm start
```

## Configuration

All in `.env`:

| Var | Required | Default | Description |
|-----|----------|---------|-------------|
| `DISCORD_TOKEN` | yes | | Bot token from Discord Developer Portal |
| `ALLOWED_USER_ID` | yes | | Your Discord user ID. ONLY this user can trigger the bot. |
| `ALLOWED_CHANNEL_ID` | yes | | Channel where the bot listens. Use a private channel. |
| `CLAUDE_PROJECT_DIR` | yes | | Absolute path to your project root |
| `CLAUDE_PERMISSION_MODE` | no | `bypassPermissions` | `bypassPermissions` for full headless autonomy |
| `CLAUDE_DEFAULT_MODEL` | no | `haiku` | Model for short messages |
| `CLAUDE_HEAVY_MODEL` | no | `sonnet` | Model for long/heavy prompts |
| `WHISPER_MODEL` | no | `base` | `tiny` / `base` / `small` / `medium` / `large-v3` |

## Auto-model selection

To save time and tokens:

- Short, casual messages: `haiku` (~5-8s)
- Long messages (280+ chars) or messages with heavy keywords (refactor, debug, security, audit, etc.): `sonnet` (~15-20s)

You can override per-message:

- `!h <prompt>` forces Haiku
- `!s <prompt>` forces Sonnet
- `!o <prompt>` forces Opus

## Personalize Claude's behavior

Drop an `instructions.md` file next to `index.js`. Its contents are appended to the bot's system instructions on every message.

Example `instructions.md`:

```
- I work on a Next.js + Supabase + Cloudflare project
- Reply in casual Hinglish
- Never run database push commands directly, even if I ask
- Match my coding style (no extra comments, no boilerplate)
- For long-running commands always use background mode
```

Your project's `CLAUDE.md` (if present in project root) and the project memory at `~/.claude/projects/<project-key>/memory/` are auto-loaded by Claude Code, so put your real preferences there. `instructions.md` is for bot-specific behavior.

## Voice messages

If Python and `faster-whisper` are installed, the bot transcribes voice messages locally. First voice message auto-downloads the Whisper model (~150MB for `base`).

Reactions:
- 🎙️ = transcribing
- ✅ = transcription complete
- ❌ = transcription failed

The transcription is shown back to you (so you can confirm what was heard), then sent to Claude as the prompt.

For better accuracy with non-English / accented speech, set `WHISPER_MODEL=small` or higher in `.env`.

## Special commands

| Command (in Discord) | Action |
|---|---|
| `!reset` | Deletes session, exits the bot. PM2 auto-restarts with a fresh session. |
| `!h <prompt>` | Force Haiku model |
| `!s <prompt>` | Force Sonnet model |
| `!o <prompt>` | Force Opus model |

## Auto-startup (PM2)

The setup script configures PM2 + `pm2-windows-startup` so the bot:

- Auto-starts when your PC boots
- Auto-restarts if it crashes
- Logs to `~/.pm2/logs/`

Daily commands:

```bash
pm2 status                         # is it running?
pm2 logs discord-claude            # live logs
pm2 logs discord-claude --lines 30 --nostream  # snapshot of last 30 lines
pm2 restart discord-claude         # after code change
pm2 stop discord-claude            # pause
pm2 delete discord-claude && pm2 save  # remove
pm2-startup uninstall              # disable auto-startup
```

## Continue a Discord conversation in terminal

```bash
cd /path/to/your/project
claude --resume <session-uuid>
```

The UUID is printed at bot startup and saved in `.claude-session-id`. The Discord chat and the terminal share the same session, so you can switch back and forth.

## Security

The bot has FULL access to your project: read files, run shell, edit code, push commits if Claude decides to. So:

1. **Bot token leak = full access compromised.** Never paste it in chat, screenshots, or commit it. The setup writes it to `.env` which is gitignored.
2. **`ALLOWED_USER_ID` is the main guard.** Only your User ID's messages get executed. Even if someone gets access to the channel, they can't trigger the bot.
3. **Use a private channel.** Belt and suspenders.
4. **Don't share your `.env` or `.claude-session-id`.**

## Troubleshooting

**`Used disallowed intents` in logs**

You forgot to click "Save Changes" after enabling MESSAGE CONTENT INTENT. Go back to Discord Developer Portal → Bot → Privileged Gateway Intents, toggle it ON, click the green Save Changes button at the bottom, then `pm2 restart discord-claude`.

**Bot is online but not replying**

Check logs: `pm2 logs discord-claude --lines 30 --nostream`

Common causes:
- Wrong User ID or Channel ID in `.env`
- Bot doesn't have permission to view/send in that channel
- `claude` CLI not authenticated (`claude auth status`)

**`claude: command not found` in bot logs**

Claude Code CLI isn't on PATH for the PM2 process. Reinstall claude globally and restart pm2.

**Voice transcription failing**

Check `pm2 logs discord-claude` for `[whisper stderr]` lines. Common: Python not installed, faster-whisper not installed, or model download blocked by firewall.

**Long replies cut off**

The bot auto-chunks responses at 1900 chars (Discord limit is 2000). If a single line exceeds 1900 chars, it gets split mid-line.

## File structure

```
claude-discord-bridge/
├── setup.cmd            # Wrapper that calls setup.ps1
├── setup.ps1            # Interactive setup (asks for token, IDs, project path)
├── index.js             # Bot main logic
├── transcribe.py        # Whisper voice-to-text helper
├── package.json
├── .env.example         # Config template
├── .env                 # Your config (gitignored, generated by setup)
├── .gitignore
├── instructions.md      # Optional: your custom instructions for Claude
└── README.md
```

## License

MIT. Use, modify, share.

## Credits

Built by [@fiaz-zafar-metaviz](https://github.com/fiaz-zafar-metaviz). Wrap of Claude Code CLI + discord.js + faster-whisper.