import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  DISCORD_TOKEN,
  ALLOWED_USER_ID,
  ALLOWED_CHANNEL_ID,
  CLAUDE_PROJECT_DIR,
  CLAUDE_PERMISSION_MODE = 'bypassPermissions',
  CLAUDE_DEFAULT_MODEL = 'haiku',
  CLAUDE_HEAVY_MODEL = 'sonnet',
} = process.env;

const HEAVY_KEYWORDS = [
  'refactor', 'debug', 'fix bug', 'implement', 'design', 'architect',
  'migration', 'migrate', 'security', 'audit', 'review', 'analyze', 'analyse',
  'optimize', 'optimise', 'performance', 'investigate', 'plan', 'strategy',
  'deploy', 'production', 'compare', 'tradeoff', 'why is', 'why does',
  'explain how', 'walk me through', 'breakdown',
];

function pickModel(prompt) {
  const trimmed = prompt.trim();

  if (/^!h\s/i.test(trimmed) || /^!haiku\s/i.test(trimmed)) return { model: 'haiku', stripped: trimmed.replace(/^!h(aiku)?\s+/i, '') };
  if (/^!s\s/i.test(trimmed) || /^!sonnet\s/i.test(trimmed)) return { model: 'sonnet', stripped: trimmed.replace(/^!s(onnet)?\s+/i, '') };
  if (/^!o\s/i.test(trimmed) || /^!opus\s/i.test(trimmed)) return { model: 'opus', stripped: trimmed.replace(/^!o(pus)?\s+/i, '') };

  const lower = trimmed.toLowerCase();
  const hasHeavyKeyword = HEAVY_KEYWORDS.some((k) => lower.includes(k));
  const isLong = trimmed.length > 280;

  if (hasHeavyKeyword || isLong) {
    return { model: CLAUDE_HEAVY_MODEL, stripped: trimmed };
  }
  return { model: CLAUDE_DEFAULT_MODEL, stripped: trimmed };
}

for (const [k, v] of Object.entries({ DISCORD_TOKEN, ALLOWED_USER_ID, ALLOWED_CHANNEL_ID, CLAUDE_PROJECT_DIR })) {
  if (!v) {
    console.error(`Missing required env: ${k}`);
    console.error(`Edit .env file (copy from .env.example)`);
    process.exit(1);
  }
}

const SESSION_FILE = path.join(__dirname, '.claude-session-id');
const STARTED_FILE = path.join(__dirname, '.claude-session-started');

function getSessionId() {
  if (fs.existsSync(SESSION_FILE)) {
    return fs.readFileSync(SESSION_FILE, 'utf8').trim();
  }
  const id = randomUUID();
  fs.writeFileSync(SESSION_FILE, id);
  return id;
}

const SESSION_ID = getSessionId();
console.log(`Claude session id: ${SESSION_ID}`);
console.log(`To continue this conversation in terminal: claude --resume ${SESSION_ID}`);

// Optional user-provided custom instructions (instructions.md in same folder).
// If present, contents get appended to the default INSTRUCTIONS template.
// Use this to add project-specific context, your coding style, framework details, etc.
let CUSTOM_INSTRUCTIONS = '';
const customFile = path.join(__dirname, 'instructions.md');
if (fs.existsSync(customFile)) {
  CUSTOM_INSTRUCTIONS = '\n\n==== USER-PROVIDED CUSTOM INSTRUCTIONS ====\n' + fs.readFileSync(customFile, 'utf8').trim();
  console.log(`Loaded custom instructions from instructions.md (${CUSTOM_INSTRUCTIONS.length} chars)`);
}

const INSTRUCTIONS = `[You are the user's Discord-side Claude Code instance. Same model, same tools, same auth, SAME CAPABILITIES as the IDE-side Claude. They are chatting from Discord. You ARE their Claude Code with full proactive autonomy.

==== PROJECT ====
Path: ${CLAUDE_PROJECT_DIR}

The user's CLAUDE.md (if present in project root) and project memory at ~/.claude/projects/<project-key>/memory/ are AUTO-LOADED. These contain user preferences, project facts, and rules. FOLLOW them strictly.

==== YOUR CAPABILITIES (use proactively, don't doubt yourself) ====
- File: Read, Edit, Write, Glob, Grep
- Shell: Bash. For ANY long-running cmd (dev/start/build/watch/server/db start) ALWAYS run_in_background: true and reply IMMEDIATELY. Never block.
- Sub-agents: Task tool. Spawn Explore subagent for big codebase scans, general-purpose for parallel work.
- Web: WebFetch (specific URLs), WebSearch (latest info, version checks, library docs, error lookups).
- MCP servers: whatever is configured in user's .mcp.json or project mcp config.
- Skills: any installed Claude Code skills (/init, /review, /security-review, simplify, etc.).

==== HOW TO BEHAVE ====
- Short Discord prompts equal full intent. Interpret like a senior dev would. Don't ask trivial clarifying questions.
- Just DO the work: investigate, run, edit, test, then briefly report what you did.
- Treat short messages like terminal commands, interpret intent, execute.
- Reply short and casual. Match the user's language and energy. Discord-style, no long paragraphs.
- USE TOOLS for any "can you see X" / "what's in Y" question, never give vague answers.
- Code changes: Edit/Write directly, then brief summary of what changed.
- Need current/web info: use WebSearch/WebFetch, don't guess versions or APIs.
- Big task (multi-file scan/refactor): spawn Task subagents in parallel for speed.
- Risky action (git push, deploy, db change, force-push, file delete): confirm first.
- Long output is auto-chunked at 1900 chars by the bot, just respond naturally.

==== COLLABORATION TIPS ====
1. RUN THINGS YOURSELF when possible, don't just tell the user "run this command". If you can do it (git status, npm install, file read, pm2 restart), do it and report.
2. Verify before assuming. Check git status, file existence, package versions before claiming things.
3. NO BLOAT. No padding phrases ("as a result", "in conclusion", "furthermore"). One direct statement is better.
4. NO unnecessary code comments. Only when WHY is non-obvious. Don't add "// added for X feature" type breadcrumbs.
5. NO speculative features. Fix exactly what's asked, no extra cleanup, no "while we're at it".
6. Match the user's energy. If they're casual, be casual. If they're terse, be terse.
7. File references: use file_path:line_number format, or markdown links [filename.ts:42](src/filename.ts#L42).
8. Parallelize tool calls when independent.
9. When something IS on user's side (browser click, paste, restart), give EXACT copy-paste commands or click-by-click steps.
10. Token / secret leak warning: if user pastes a credential in chat, IMMEDIATELY remind them to rotate it.
11. End multi-step work with ONE sentence: what changed and what's next.${CUSTOM_INSTRUCTIONS}]`;

const queue = [];
let busy = false;

async function transcribeAudio(attachment) {
  console.log(`[whisper] downloading ${attachment.name} (${attachment.size} bytes)`);
  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`Audio download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const ext = path.extname(attachment.name) || '.ogg';
  const tmpFile = path.join(os.tmpdir(), `discord-voice-${Date.now()}${ext}`);
  fs.writeFileSync(tmpFile, buf);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    console.log(`[whisper] spawn python transcribe.py`);
    const py = spawn('python', [path.join(__dirname, 'transcribe.py'), tmpFile], {
      shell: true,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    py.stdout.on('data', (d) => (stdout += d.toString()));
    py.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      console.log(`[whisper stderr] ${s.trim()}`);
    });
    py.on('error', reject);
    py.on('close', (code) => {
      const ms = Date.now() - startedAt;
      try { fs.rmSync(tmpFile, { force: true }); } catch {}
      console.log(`[whisper] exited code=${code} in ${ms}ms`);
      if (code !== 0) {
        return reject(new Error(`Transcription failed (${code}): ${stderr.slice(0, 500)}`));
      }
      resolve(stdout.trim());
    });
  });
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const isFirstRun = !fs.existsSync(STARTED_FILE);
    const sessionFlags = isFirstRun
      ? ['--session-id', SESSION_ID]
      : ['--resume', SESSION_ID];

    const { model, stripped } = pickModel(prompt);
    const wrappedPrompt = `${INSTRUCTIONS}\n\n${stripped}`;
    const args = [
      '-p',
      ...sessionFlags,
      '--permission-mode', CLAUDE_PERMISSION_MODE,
      '--model', model,
      '--output-format', 'json',
    ];

    console.log(`[claude] spawn (${isFirstRun ? 'create' : 'resume'} ${SESSION_ID}) model=${model}`);
    const startedAt = Date.now();

    const proc = spawn('claude', args, {
      cwd: CLAUDE_PROJECT_DIR,
      shell: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdin.write(wrappedPrompt);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      console.log(`[claude stderr] ${s.trim()}`);
    });

    proc.on('error', (err) => {
      console.error('[claude] spawn error:', err);
      reject(err);
    });
    proc.on('close', (code) => {
      const ms = Date.now() - startedAt;
      console.log(`[claude] exited code=${code} in ${ms}ms, stdout=${stdout.length}b, stderr=${stderr.length}b`);
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}\nstderr: ${stderr.slice(0, 500)}\nstdout: ${stdout.slice(0, 500)}`));
      }
      if (isFirstRun) {
        fs.writeFileSync(STARTED_FILE, '1');
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed.result ?? stdout);
      } catch (e) {
        console.log(`[claude] JSON parse failed, returning raw stdout`);
        resolve(stdout);
      }
    });
  });
}

function chunkText(text, size = 1900) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > size) {
    let cut = remaining.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}

function ackMessageFor(content) {
  const { model } = pickModel(content);
  const lower = content.toLowerCase();

  const willBeSlow = model !== CLAUDE_DEFAULT_MODEL || content.length > 280;
  const isAction = /(\bfix\b|\bbuild\b|\bdeploy\b|\brefactor\b|\bimplement\b|\bcreate\b|\bchala\b|\brun\b|\bdebug\b|\bmigrate\b|\binstall\b|\bupgrade\b|\boptimize\b|\bscan\b|\baudit\b|\breview\b|\bresearch\b|\bsearch\b|\bcheck\b|\binvestigate\b)/i.test(lower);

  if (!willBeSlow && !isAction) return null;

  if (/refactor|migrate|build|deploy|audit|review/i.test(lower)) return 'on it. this looks substantial, give me a minute or two...';
  if (/fix|debug/i.test(lower)) return 'looking into it...';
  if (/research|search|investigate|scan/i.test(lower)) return 'researching now...';
  if (/install|upgrade/i.test(lower)) return 'installing...';
  if (/run|start/i.test(lower)) return 'starting it up...';
  return 'on it...';
}

async function processQueue(client) {
  if (busy || queue.length === 0) return;
  busy = true;
  const { message, content } = queue.shift();
  try {
    const ack = ackMessageFor(content);
    if (ack) {
      await message.reply(ack).catch(() => {});
    }

    await message.channel.sendTyping();
    const typingInterval = setInterval(() => {
      message.channel.sendTyping().catch(() => {});
    }, 8000);

    const reply = await runClaude(content);
    clearInterval(typingInterval);

    const text = (reply || '(empty response)').trim();
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      await message.reply(chunk);
    }
  } catch (err) {
    console.error(err);
    await message.reply(`error: ${err.message.slice(0, 1800)}`);
  } finally {
    busy = false;
    processQueue(client);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Listening on channel ${ALLOWED_CHANNEL_ID} from user ${ALLOWED_USER_ID}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== ALLOWED_CHANNEL_ID) return;
  if (message.author.id !== ALLOWED_USER_ID) return;

  let content = message.content?.trim() || '';
  const audioAttachment = message.attachments?.find?.((a) => (a.contentType || '').startsWith('audio/'));

  if (audioAttachment) {
    try {
      await message.react('🎙️').catch(() => {});
      await message.channel.sendTyping();
      const transcription = await transcribeAudio(audioAttachment);
      await message.react('✅').catch(() => {});

      if (!transcription) {
        await message.reply('voice message transcription empty. send as text.');
        return;
      }

      const transcriptPreview = transcription.length > 1800 ? transcription.slice(0, 1800) + '...' : transcription;
      await message.reply(`> ${transcriptPreview}\n\n_(voice transcribed, processing...)_`);

      content = content ? `${content}\n\n${transcription}` : transcription;
    } catch (err) {
      console.error('[whisper] error:', err);
      await message.react('❌').catch(() => {});
      await message.reply(`voice transcribe failed: ${err.message.slice(0, 500)}`);
      return;
    }
  }

  if (!content) return;

  if (content === '!reset') {
    fs.rmSync(SESSION_FILE, { force: true });
    fs.rmSync(STARTED_FILE, { force: true });
    await message.reply('session reset. next message starts fresh.');
    process.exit(0);
  }

  console.log(`[msg] from ${message.author.tag}: ${content.slice(0, 100)}`);
  queue.push({ message, content });
  processQueue(client);
});

client.login(DISCORD_TOKEN);