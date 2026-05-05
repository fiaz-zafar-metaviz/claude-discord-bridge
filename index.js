import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Events,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  DISCORD_TOKEN,
  ALLOWED_USER_ID,
  ALLOWED_CHANNEL_ID,
  CLAUDE_PROJECT_DIR,
  CLAUDE_PERMISSION_MODE = 'bypassPermissions',
  CLAUDE_DEFAULT_MODEL = 'haiku',
  CLAUDE_HEAVY_MODEL = 'sonnet',
  AGENT_MODE = 'true',
  PING_AFTER_MS = '60000',
} = process.env;

const IS_AGENT_MODE = AGENT_MODE.toLowerCase() === 'true';
const PING_AFTER = parseInt(PING_AFTER_MS) || 60000;

const HEAVY_KEYWORDS = [
  'refactor', 'debug', 'fix bug', 'implement', 'design', 'architect',
  'migration', 'migrate', 'security', 'audit', 'review', 'analyze', 'analyse',
  'optimize', 'optimise', 'performance', 'investigate', 'plan', 'strategy',
  'deploy', 'production', 'compare', 'tradeoff', 'why is', 'why does',
  'explain how', 'walk me through', 'breakdown',
];

function pickModel(prompt) {
  const trimmed = prompt.trim();

  // Explicit override prefixes (highest priority)
  if (/^\.h\s/i.test(trimmed) || /^\.haiku\s/i.test(trimmed)) return { model: 'haiku', stripped: trimmed.replace(/^\.h(aiku)?\s+/i, '') };
  if (/^\.s\s/i.test(trimmed) || /^\.sonnet\s/i.test(trimmed)) return { model: 'sonnet', stripped: trimmed.replace(/^\.s(onnet)?\s+/i, '') };
  if (/^\.o\s/i.test(trimmed) || /^\.opus\s/i.test(trimmed)) return { model: 'opus', stripped: trimmed.replace(/^\.o(pus)?\s+/i, '') };

  // Auto: heavy if long prompt or contains heavy keywords
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
    process.exit(1);
  }
}

const SESSION_FILE = path.join(__dirname, '.claude-session-id');
const STARTED_FILE = path.join(__dirname, '.claude-session-started');
const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');
const TTS_STATE_FILE = path.join(__dirname, '.tts-enabled');
const TTS_VOICE = process.env.TTS_VOICE || 'en-US-AriaNeural';

function getSessionId() {
  if (fs.existsSync(SESSION_FILE)) {
    return fs.readFileSync(SESSION_FILE, 'utf8').trim();
  }
  const id = randomUUID();
  fs.writeFileSync(SESSION_FILE, id);
  return id;
}

let SESSION_ID = getSessionId();
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

==== AGENT MODE (CRITICAL — ${IS_AGENT_MODE ? 'ENABLED' : 'OFF'}) ====
${IS_AGENT_MODE ? `User is OFTEN AWAY FROM PC. You have FULL PC CONTROL via Bash. Behave like an autonomous remote agent:
- NEVER tell user "you have to install X" or "you do Y on your PC". You install it / do it yourself.
- For missing CLI tools on Windows: try in order \`choco install X\`, \`scoop install X\`, \`winget install X\`, \`npm i -g X\`, \`pip install X\`. On Mac: brew. On Linux: apt/yum/dnf. ONLY ask user if all fail.
- For Windows GUI tasks (open browser, click button), use PowerShell automation: \`Start-Process\`, \`Add-Type -AssemblyName System.Windows.Forms\`, \`SendKeys\`.
- For browser automation, use playwright (\`npx playwright codegen\` to record, or write a script).
- For screenshots, use OS-native tools (Windows: PowerShell + System.Drawing; Mac: \`screencapture\`; Linux: \`scrot\`).
- Don't ask permission for installs or file changes or system tweaks. Just do, then briefly report.
- If a task takes 60s+, the bot itself will @ping the user when done so they get a phone notification.` : 'Agent mode disabled. Be more conservative, ask for permission on installs and system changes.'}

==== LIVE PROGRESS UPDATES (only major milestones, save tokens) ====
For LONG tasks (audits, scans, multi-page Playwright work), occasionally append a SHORT line to \`.live-progress.log\` inside the bot folder. Keep it MINIMAL.

**FIRST-LINE ACK (mandatory for >1min tasks):** If you expect this task to take more than ~1 minute, the FIRST thing you do (before any other tool call) is append a brief one-line acknowledgment to .live-progress.log written in YOUR OWN words referencing what the user actually asked. Make it specific to THIS task. For tasks under 1 min, skip the ack.

Rules (STRICT):
- MAX 4-5 progress lines for an entire task. Don't narrate every tool use.
- Only post at MAJOR milestones: "starting", "halfway done (X of Y)", "finishing".
- One short line, casual.
- BAD: per-tool narration like "playwright launch", "page X done", "modal try kar raha", etc.
- Use Bash: \`echo "5 pages done, 3 left" >> .live-progress.log\` (relative to bot folder; the bot tails it and forwards updates to Discord)
- Skip progress entirely for tasks under 30s.
- Final result goes via normal reply (not this file).

==== HOW TO BEHAVE ====
- Short Discord prompts equal full intent. Interpret like a senior dev would. Don't ask trivial clarifying questions.
- Just DO the work: investigate, run, edit, test, then briefly report what you did.
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
4. NO unnecessary code comments. Only when WHY is non-obvious.
5. NO speculative features. Fix exactly what's asked, no extra cleanup.
6. Match the user's energy. If they're casual, be casual. If they're terse, be terse.
7. File references: use file_path:line_number format, or markdown links [filename.ts:42](src/filename.ts#L42).
8. Parallelize tool calls when independent.
9. When something IS on user's side (browser click, paste, restart), give EXACT copy-paste commands or click-by-click steps.
10. Token / secret leak warning: if user pastes a credential in chat, IMMEDIATELY remind them to rotate it.
11. End multi-step work with ONE sentence: what changed and what's next.${CUSTOM_INSTRUCTIONS}]`;

const queue = [];
let busy = false;
let currentTask = null; // { content, startedAt } while a task is being processed

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

function spawnClaudeOnce(wrappedPrompt, sessionFlags, sessionId, model) {
  return new Promise((resolve) => {
    const args = [
      '-p',
      ...sessionFlags,
      '--permission-mode', CLAUDE_PERMISSION_MODE,
      '--model', model,
      '--output-format', 'json',
    ];

    console.log(`[claude] spawn ${sessionFlags.join(' ')} model=${model}`);
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

    proc.on('close', (code) => {
      const ms = Date.now() - startedAt;
      console.log(`[claude] exited code=${code} in ${ms}ms, stdout=${stdout.length}b`);
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch {}
      resolve({ code, stdout, stderr, parsed, ms });
    });
    proc.on('error', (err) => {
      console.error('[claude] spawn error:', err);
      resolve({ code: -1, stdout: '', stderr: err.message, parsed: null, ms: Date.now() - startedAt });
    });
  });
}

async function runClaude(prompt) {
  const { model, stripped } = pickModel(prompt);
  const wrappedPrompt = `${INSTRUCTIONS}\n\n${stripped}`;

  const isFirstRun = !fs.existsSync(STARTED_FILE);
  const sessionFlags = isFirstRun
    ? ['--session-id', SESSION_ID]
    : ['--resume', SESSION_ID];

  let result = await spawnClaudeOnce(wrappedPrompt, sessionFlags, SESSION_ID, model);

  // Auto-recover from bloated session: "Prompt is too long" / context overflow
  const bloated =
    result.parsed?.is_error === true &&
    typeof result.parsed?.result === 'string' &&
    /(prompt is too long|context.*length|maximum context)/i.test(result.parsed.result);

  // Auto-recover from "Session ID ... is already in use" — happens when a stale
  // lock points at the saved session. We can't reuse it, so spin up a fresh one.
  const sessionLocked =
    /session id .* is already in use/i.test(result.stderr || '') ||
    /session id .* is already in use/i.test(result.stdout || '') ||
    (typeof result.parsed?.result === 'string' && /session id .* is already in use/i.test(result.parsed.result));

  if (bloated || sessionLocked) {
    console.log(`[claude] ${bloated ? 'session bloated' : 'session locked'}, auto-resetting and retrying`);
    fs.rmSync(SESSION_FILE, { force: true });
    fs.rmSync(STARTED_FILE, { force: true });
    const newId = randomUUID();
    fs.writeFileSync(SESSION_FILE, newId);
    SESSION_ID = newId;
    result = await spawnClaudeOnce(wrappedPrompt, ['--session-id', newId], newId, model);
    if (result.code === 0 && !result.parsed?.is_error) {
      fs.writeFileSync(STARTED_FILE, '1');
    }
  } else if (result.code === 0 && isFirstRun) {
    fs.writeFileSync(STARTED_FILE, '1');
  }

  if (result.code !== 0 || result.parsed?.is_error) {
    const errResult = result.parsed?.result || result.stderr || result.stdout.slice(0, 600);
    throw new Error(`claude error (${result.code}): ${errResult}`);
  }

  return result.parsed?.result ?? result.stdout;
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

  // Auto-ack for heavy tasks (takes >15-20s typically)
  const willBeSlow = model !== CLAUDE_DEFAULT_MODEL || content.length > 280;
  // Tasks that involve actually doing things (not just reading)
  const isAction = /(\bfix\b|\bbuild\b|\bdeploy\b|\brefactor\b|\bimplement\b|\bcreate\b|\bbana\b|\bbnao\b|\bchala\b|\brun\b|\bdebug\b|\bmigrate\b|\binstall\b|\bupgrade\b|\boptimize\b|\bscan\b|\baudit\b|\breview\b|\bresearch\b|\bsearch\b|\bcheck\b|\binvestigate\b)/i.test(lower);

  if (!willBeSlow && !isAction) return null;

  // Pick a casual ack
  if (/refactor|migrate|build|deploy|audit|review/i.test(lower)) return 'ok bhai, ye sahi kaam hai, kar raha hu... 1-2 min lag sakta hai';
  if (/fix|debug/i.test(lower)) return 'theek hai, dekh ke fix karta hu...';
  if (/research|search|investigate|scan/i.test(lower)) return 'samjha, dhundta hu thoda...';
  if (/install|upgrade/i.test(lower)) return 'ok, install kar raha hu...';
  if (/run|chala|start/i.test(lower)) return 'chalu kar raha hu...';
  return 'ok, ye kar raha hu...';
}

async function processQueue(client) {
  if (busy || queue.length === 0) return;
  busy = true;
  const { message, content } = queue.shift();
  currentTask = { content, startedAt: Date.now() };
  try {
    // No static acks — Claude himself writes a one-line ack to .live-progress.log
    // for tasks he expects to take >1 minute (see INSTRUCTIONS).
    await message.channel.sendTyping();
    const typingInterval = setInterval(() => {
      message.channel.sendTyping().catch(() => {});
    }, 8000);

    // Live progress: Claude appends lines to .live-progress.log; we watch and post.
    const progressFile = path.join(__dirname, '.live-progress.log');
    try { fs.writeFileSync(progressFile, ''); } catch {}
    let progressBytesPosted = 0;
    const flushProgress = async () => {
      try {
        const buf = fs.readFileSync(progressFile, 'utf8');
        if (buf.length <= progressBytesPosted) return;
        const fresh = buf.slice(progressBytesPosted);
        progressBytesPosted = buf.length;
        const lines = fresh.split('\n').map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
          await message.channel.send(`💭 ${line.slice(0, 1800)}`).catch(() => {});
        }
      } catch (e) {
        console.error('[progress] read error:', e.message);
      }
    };
    const watcher = fs.watch(progressFile, { persistent: false }, (evt) => {
      if (evt === 'change') flushProgress();
    });

    const startedAt = Date.now();
    const reply = await runClaude(content);
    const elapsed = Date.now() - startedAt;
    clearInterval(typingInterval);
    try { watcher.close(); } catch {}
    await flushProgress();

    const text = (reply || '(empty response)').trim();

    // For long tasks, prefix the result with @mention so user gets phone notification
    const shouldPing = elapsed > PING_AFTER;
    const mention = shouldPing ? `<@${ALLOWED_USER_ID}> ` : '';

    // Per-feature post mode: if reply contains FEATURE_POST_START/END blocks, send each as
    // a separate Discord message with its screenshot attached.
    const featureBlockRegex = /###\s*FEATURE_POST_START\s*([\s\S]*?)###\s*FEATURE_POST_END/g;
    const featureBlocks = [...text.matchAll(featureBlockRegex)];

    if (featureBlocks.length > 0) {
      // Send any text BEFORE the first block (intro/preface) as a normal reply
      const firstBlockStart = text.indexOf('### FEATURE_POST_START');
      const preface = text.slice(0, firstBlockStart).trim();
      if (preface) {
        const prefaceChunks = chunkText(preface);
        for (let i = 0; i < prefaceChunks.length; i++) {
          const prefix = (i === 0 && mention) ? mention : '';
          await message.reply(prefix + prefaceChunks[i]);
        }
      }

      // Send each feature block as its own message, with attachment if present
      for (let i = 0; i < featureBlocks.length; i++) {
        const blockBody = featureBlocks[i][1].trim();
        const attMatch = blockBody.match(/^ATTACHMENT:\s*(.+)$/im);
        const attPath = attMatch ? attMatch[1].trim().replace(/^["']|["']$/g, '') : null;
        const bodyText = blockBody.replace(/^ATTACHMENT:.*$/im, '').trim();

        const files = [];
        if (attPath) {
          try {
            if (fs.existsSync(attPath)) {
              files.push(new AttachmentBuilder(attPath).setName(path.basename(attPath)));
            } else {
              console.warn(`[updates] attachment missing: ${attPath}`);
            }
          } catch (e) {
            console.warn(`[updates] attachment error: ${e.message}`);
          }
        }

        // Mention only on the very first message of the whole reply
        const prefix = (i === 0 && !preface && mention) ? mention : '';
        try {
          await message.reply({ content: (prefix + bodyText).slice(0, 1900), files });
        } catch (e) {
          console.error('[updates] feature post error:', e.message);
          await message.reply(`(feature ${i + 1} post failed: ${e.message.slice(0, 200)})`).catch(() => {});
        }
      }

      // Send any text AFTER the last block (final summary line)
      const lastBlockEnd = text.lastIndexOf('### FEATURE_POST_END') + '### FEATURE_POST_END'.length;
      const epilogue = text.slice(lastBlockEnd).trim();
      if (epilogue) {
        const epilogueChunks = chunkText(epilogue);
        for (const c of epilogueChunks) {
          await message.reply(c).catch(() => {});
        }
      }
    } else {
      // Normal reply mode (no feature blocks)
      const chunks = chunkText(text);
      for (let i = 0; i < chunks.length; i++) {
        const prefix = (i === 0 && mention) ? mention : '';
        await message.reply(prefix + chunks[i]);
      }
    }

    // TTS audio reply if enabled
    if (isTtsEnabled() && text && text.length > 5) {
      try {
        const audioFile = await generateTts(text);
        const att = new AttachmentBuilder(audioFile).setName('reply.mp3');
        await message.reply({ files: [att] }).catch(() => {});
        try { fs.rmSync(audioFile, { force: true }); } catch {}
      } catch (e) {
        console.error('[tts] error:', e);
      }
    }
  } catch (err) {
    console.error(err);
    await message.reply(`error: ${err.message.slice(0, 1800)}`);
  } finally {
    busy = false;
    currentTask = null;
    processQueue(client);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Listening on channel ${ALLOWED_CHANNEL_ID} from user ${ALLOWED_USER_ID}`);
  loadAndStartAllSchedules(client);
});

// ---------- Scheduled tasks (cron) ----------
function loadSchedules() {
  if (!fs.existsSync(SCHEDULES_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8')); } catch { return []; }
}
function saveSchedules(list) {
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(list, null, 2));
}

const activeJobs = new Map(); // id -> cron task

function startSchedule(client, schedule) {
  if (!cron.validate(schedule.cronExpr)) {
    console.error(`[cron] invalid expr: ${schedule.cronExpr}`);
    return false;
  }
  const task = cron.schedule(schedule.cronExpr, async () => {
    console.log(`[cron] firing schedule ${schedule.id}: ${schedule.task}`);
    try {
      const channel = await client.channels.fetch(ALLOWED_CHANNEL_ID);
      if (!channel) return;
      await channel.send(`<@${ALLOWED_USER_ID}> ⏰ scheduled task fired: \`${schedule.task}\``);
      const reply = await runClaude(schedule.task);
      const text = (reply || '(empty)').trim();
      const chunks = chunkText(text);
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    } catch (e) {
      console.error('[cron] error firing:', e);
    }
  });
  activeJobs.set(schedule.id, task);
  return true;
}

function loadAndStartAllSchedules(client) {
  const all = loadSchedules();
  let started = 0;
  for (const s of all) {
    if (startSchedule(client, s)) started++;
  }
  console.log(`[cron] loaded ${started}/${all.length} schedules`);
}

// ---------- Page scanner (Playwright) ----------
async function runScanScript(url, outDir) {
  return new Promise((resolve, reject) => {
    const p = spawn('node', [path.join(__dirname, 'scan.js'), url, outDir], {
      cwd: __dirname,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      console.log(`[scan stderr] ${s.trim()}`);
    });
    p.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`scan script exited ${code}: ${stderr.slice(0, 400)}`));
      }
      try {
        const result = JSON.parse(stdout.trim().split('\n').pop());
        resolve(result);
      } catch (e) {
        reject(new Error(`bad scan output: ${e.message}\n${stdout.slice(0, 300)}`));
      }
    });
  });
}

// ---------- Mic stream (PC mic to Discord voice channel) ----------
let activeStream = null;
const MIC_DEVICE = process.env.MIC_DEVICE || 'Headset Microphone (Plantronics C310-M)';
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID || '';

async function startMicStream(client, message) {
  if (activeStream) {
    await message.reply('🎤 already streaming. use `.stopstream` first.');
    return;
  }

  // Find target voice channel:
  // 1. VOICE_CHANNEL_ID env var (explicit)
  // 2. User's current voice channel (if they're in one)
  // 3. First voice channel in the guild bot can access (auto-detect)
  let targetChannel = null;

  if (VOICE_CHANNEL_ID) {
    try { targetChannel = await client.channels.fetch(VOICE_CHANNEL_ID); } catch {}
  }
  if (!targetChannel && message.member?.voice?.channel) {
    targetChannel = message.member.voice.channel;
  }
  if (!targetChannel && message.guild) {
    // Auto-pick first voice channel
    const channels = await message.guild.channels.fetch();
    targetChannel = channels.find((c) => c && c.type === 2);
  }

  if (!targetChannel) {
    await message.reply('koi voice channel nahi mila is server mein. pehle ek voice channel banao (server pe `+` icon → Voice Channel → Create), fir `.stream` chala.');
    return;
  }

  if (targetChannel.type !== 2) {
    await message.reply(`channel \`${targetChannel.name}\` voice channel nahi hai.`);
    return;
  }

  await message.reply(`🎤 joining \`${targetChannel.name}\`, mic stream start...`);

  let connection;
  try {
    connection = joinVoiceChannel({
      channelId: targetChannel.id,
      guildId: targetChannel.guild.id,
      adapterCreator: targetChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
  } catch (e) {
    await message.reply(`voice connect fail: ${e.message.slice(0, 300)}`);
    return;
  }

  // FFmpeg captures mic audio via DirectShow, encodes to opus ogg
  const ffmpeg = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-f', 'dshow',
    '-i', `audio=${MIC_DEVICE}`,
    '-c:a', 'libopus',
    '-b:a', '96k',
    '-ar', '48000',
    '-ac', '2',
    '-f', 'ogg',
    'pipe:1',
  ], { windowsHide: true });

  let ffStderr = '';
  ffmpeg.stderr.on('data', (d) => {
    const s = d.toString();
    ffStderr += s;
    console.log(`[stream stderr] ${s.trim()}`);
  });
  ffmpeg.on('error', async (e) => {
    console.error('[stream] ffmpeg error:', e);
    await message.reply(`ffmpeg error: ${e.message}`).catch(() => {});
    if (activeStream) await stopMicStream(message, true);
  });

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });
  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
  player.play(resource);
  connection.subscribe(player);

  activeStream = { connection, ffmpeg, player, channelName: targetChannel.name };
  await message.reply(`✅ streaming PC mic to \`${targetChannel.name}\`. Phone se us voice channel pe join karke sun. \`.stopstream\` to stop.`);
}

async function stopMicStream(message, silent = false) {
  if (!activeStream) {
    if (!silent) await message.reply('🎤 koi stream chal nahi raha.');
    return;
  }
  const name = activeStream.channelName;
  try { activeStream.ffmpeg.kill('SIGKILL'); } catch {}
  try { activeStream.player.stop(); } catch {}
  try { activeStream.connection.destroy(); } catch {}
  activeStream = null;
  if (!silent) await message.reply(`🛑 mic stream stopped, bot left \`${name}\`.`);
}

// ---------- TTS ----------
function isTtsEnabled() {
  return fs.existsSync(TTS_STATE_FILE);
}
function setTtsEnabled(on) {
  if (on) fs.writeFileSync(TTS_STATE_FILE, '1');
  else if (fs.existsSync(TTS_STATE_FILE)) fs.rmSync(TTS_STATE_FILE);
}
async function generateTts(text) {
  const tmpFile = path.join(os.tmpdir(), `tts-${Date.now()}.mp3`);
  // Write text to temp file to avoid shell escape issues with multi-line / special chars
  const textFile = path.join(os.tmpdir(), `tts-input-${Date.now()}.txt`);
  fs.writeFileSync(textFile, text, 'utf8');

  return new Promise((resolve, reject) => {
    const py = spawn('python', [path.join(__dirname, 'tts.py'), tmpFile, '--file', textFile, TTS_VOICE], {
      shell: false,
      windowsHide: true,
    });
    let stderr = '';
    py.stderr.on('data', (d) => (stderr += d.toString()));
    py.on('close', (code) => {
      try { fs.rmSync(textFile, { force: true }); } catch {}
      if (code !== 0 || !fs.existsSync(tmpFile)) {
        return reject(new Error(`tts failed (${code}): ${stderr.slice(0, 800)}`));
      }
      resolve(tmpFile);
    });
  });
}

// ---------- Screenshot ----------
async function takeScreenshot() {
  const tmpFile = path.join(os.tmpdir(), `screenshot-${Date.now()}.png`);
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save('${tmpFile.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
`.trim();

  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', ['-NoProfile', '-Command', psScript], {
      windowsHide: true,
    });
    let stderr = '';
    ps.stderr.on('data', (d) => (stderr += d.toString()));
    ps.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(tmpFile)) {
        return reject(new Error(`screenshot failed (${code}): ${stderr.slice(0, 300)}`));
      }
      resolve(tmpFile);
    });
  });
}

// ---------- Approval buttons ----------
const pendingApprovals = new Map(); // token -> { resolve, label }

const RISKY_PATTERNS = [
  /\bdb\s*push\b/i,
  /\bdb:push\b/i,
  /supabase\s+db\s+push/i,
  /git\s+push.*(-f\b|--force\b)/i,
  /git\s+reset\s+--hard/i,
  /\brm\s+-rf\b/i,
  /Remove-Item.*-Recurse.*-Force/i,
  /wrangler\s+deploy/i,
  /npm\s+run\s+deploy/i,
];
function isRisky(cmd) {
  return RISKY_PATTERNS.some((p) => p.test(cmd));
}

async function askApproval(message, label, cmdPreview) {
  const token = randomUUID().slice(0, 8);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`approve:${token}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
  );
  const sent = await message.reply({
    content: `⚠️ confirm **${label}**:\n\`\`\`\n${cmdPreview.slice(0, 1500)}\n\`\`\`\n​`,
    components: [row],
  });
  return new Promise((resolve) => {
    pendingApprovals.set(token, { resolve, label, msg: sent });
    setTimeout(() => {
      if (pendingApprovals.has(token)) {
        pendingApprovals.delete(token);
        sent.edit({ content: `⏱️ approval timed out: **${label}**`, components: [] }).catch(() => {});
        resolve(false);
      }
    }, 5 * 60 * 1000);
  });
}

// ---------- Shell + dev server ----------
let devProcess = null;

function startDevServer() {
  if (devProcess && !devProcess.killed) return { ok: false, msg: `already running (pid ${devProcess.pid})` };
  const proc = spawn('npm', ['run', 'dev'], {
    cwd: CLAUDE_PROJECT_DIR,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  devProcess = proc;
  proc.on('exit', (code) => {
    console.log(`[dev] exited code=${code}`);
    if (devProcess === proc) devProcess = null;
  });
  return { ok: true, pid: proc.pid };
}

function killDevServer() {
  if (!devProcess || devProcess.killed) return { ok: false, msg: 'not running' };
  const pid = devProcess.pid;
  spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: true, windowsHide: true });
  devProcess = null;
  return { ok: true, pid };
}

async function runShellCmd(cmd, { cwd = CLAUDE_PROJECT_DIR, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, [], { shell: true, cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: err.message });
    });
  });
}

function formatShellResult({ code, stdout, stderr }) {
  const out = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim() || '(no output)';
  const trimmed = out.length > 1700 ? out.slice(0, 1700) + '\n...(truncated)' : out;
  return `\`exit ${code}\`\n\`\`\`\n${trimmed}\n\`\`\``;
}

async function showToast(title, body) {
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = [System.Drawing.SystemIcons]::Information
$ni.BalloonTipTitle = ${JSON.stringify(title)}
$ni.BalloonTipText = ${JSON.stringify(body)}
$ni.Visible = $true
$ni.ShowBalloonTip(5000)
Start-Sleep -Seconds 6
$ni.Dispose()
`.trim();
  return runShellCmd(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`, { timeoutMs: 10000 });
}

async function downloadImageAttachments(message) {
  const imageAttachments = message.attachments?.filter?.((a) => (a.contentType || '').startsWith('image/')) || [];
  if (imageAttachments.size === 0) return [];

  const downloads = [];
  const dropDir = path.join(CLAUDE_PROJECT_DIR, '.discord-uploads');
  if (!fs.existsSync(dropDir)) fs.mkdirSync(dropDir, { recursive: true });

  for (const att of imageAttachments.values()) {
    try {
      const res = await fetch(att.url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = path.extname(att.name) || '.png';
      const filename = `discord-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const fullPath = path.join(dropDir, filename);
      fs.writeFileSync(fullPath, buf);
      downloads.push({ path: fullPath, relative: `.discord-uploads/${filename}`, name: att.name });
      console.log(`[image] saved ${att.name} -> ${fullPath}`);
    } catch (e) {
      console.error('[image] download error:', e);
    }
  }
  return downloads;
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== ALLOWED_CHANNEL_ID) return;
  if (message.author.id !== ALLOWED_USER_ID) return;

  let content = message.content?.trim() || '';
  const audioAttachment = message.attachments?.find?.((a) => (a.contentType || '').startsWith('audio/'));

  // Image attachments
  const images = await downloadImageAttachments(message);
  if (images.length > 0) {
    const imageList = images.map((img, i) => `${i + 1}. ${img.relative} (${img.name})`).join('\n');
    const imageNote = `[User attached ${images.length} image(s) saved to your project at .discord-uploads/. Use Read tool to view them:\n${imageList}]`;
    content = content ? `${content}\n\n${imageNote}` : imageNote;
    await message.react('🖼️').catch(() => {});
  }

  if (audioAttachment) {
    try {
      await message.react('🎙️').catch(() => {});
      await message.channel.sendTyping();
      const transcription = await transcribeAudio(audioAttachment);
      await message.react('✅').catch(() => {});

      if (!transcription) {
        await message.reply('voice message transcribe nahi ho paya, kuch suna nahi. text mein bhej de.');
        return;
      }

      const transcriptPreview = transcription.length > 1800 ? transcription.slice(0, 1800) + '...' : transcription;
      await message.reply(`> ${transcriptPreview}\n\n_(voice transcribed, processing...)_`);

      content = content ? `${content}\n\n${transcription}` : transcription;
    } catch (err) {
      console.error('[whisper] error:', err);
      await message.react('❌').catch(() => {});
      await message.reply(`voice transcribe fail: ${err.message.slice(0, 500)}`);
      return;
    }
  }

  if (!content) return;

  if (await handleCommand(client, message, content)) return;

  console.log(`[msg] from ${message.author.tag}: ${content.slice(0, 100)}`);
  queue.push({ message, content });
  processQueue(client);
});

// ---------- Command dispatcher (.<cmd>) ----------
async function handleCommand(client, message, content) {
  if (!content.startsWith('.')) return false;

  // Model overrides (.h .s .o <prompt>) pass through to Claude
  if (/^\.(h|haiku|s|sonnet|o|opus)\s/i.test(content)) return false;

  if (content === '.reset') {
    fs.rmSync(SESSION_FILE, { force: true });
    fs.rmSync(STARTED_FILE, { force: true });
    await message.reply('session reset. next message starts fresh.');
    process.exit(0);
  }

  if (content === '.restart') {
    fs.rmSync(SESSION_FILE, { force: true });
    fs.rmSync(STARTED_FILE, { force: true });
    try { fs.writeFileSync(path.join(__dirname, '.live-progress.log'), ''); } catch {}
    await message.reply('🔄 restarting bot with fresh session... 2-3 sec lagega.');
    setTimeout(() => process.exit(0), 500);
    return true;
  }

  if (content === '.ss' || content === '.screenshot') {
    try {
      await message.reply('taking screenshot...');
      const file = await takeScreenshot();
      const att = new AttachmentBuilder(file).setName('screenshot.png');
      await message.reply({ files: [att] });
      try { fs.rmSync(file, { force: true }); } catch {}
    } catch (e) {
      await message.reply(`screenshot failed: ${e.message.slice(0, 300)}`);
    }
    return true;
  }

  if (content === '.status') {
    const lines = [
      '**bot status:**',
      `session: \`${SESSION_ID}\``,
      `queue: ${queue.length} pending, busy=${busy}`,
      `dev server: ${devProcess && !devProcess.killed ? `running (pid ${devProcess.pid})` : 'stopped'}`,
      `schedules: ${loadSchedules().length} active`,
      `agent mode: ${IS_AGENT_MODE ? 'on' : 'off'}`,
    ];

    if (busy && currentTask) {
      const elapsedSec = Math.round((Date.now() - currentTask.startedAt) / 1000);
      const elapsedStr = elapsedSec >= 60
        ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
        : `${elapsedSec}s`;
      const taskPreview = currentTask.content.replace(/\s+/g, ' ').trim().slice(0, 150);

      lines.push('', `**🟢 currently working** (${elapsedStr}):`, `> ${taskPreview}${currentTask.content.length > 150 ? '...' : ''}`);

      let progressLines = [];
      try {
        const buf = fs.readFileSync(path.join(__dirname, '.live-progress.log'), 'utf8');
        progressLines = buf.split('\n').map((l) => l.trim()).filter(Boolean).slice(-8);
      } catch {}

      if (progressLines.length > 0) {
        lines.push('', '**recent progress:**');
        for (const l of progressLines) lines.push(`💭 ${l.slice(0, 300)}`);
      } else {
        lines.push('', '_abhi koi progress milestone nahi mila_');
      }
    }

    await message.reply(lines.join('\n').slice(0, 1900));
    return true;
  }

  if (content === '.git') {
    await message.reply('checking git...');
    const status = await runShellCmd('git status -sb', { timeoutMs: 10000 });
    const log = await runShellCmd('git log -5 --oneline', { timeoutMs: 10000 });
    await message.reply(`**status:**\n\`\`\`\n${(status.stdout || '(clean)').trim()}\n\`\`\`\n**recent:**\n\`\`\`\n${log.stdout.trim()}\n\`\`\``);
    return true;
  }

  if (content === '.dev') {
    const r = startDevServer();
    if (r.ok) await message.reply(`✅ dev server started (pid ${r.pid}). use \`.killdev\` to stop.`);
    else await message.reply(`⚠️ ${r.msg}`);
    return true;
  }

  if (content === '.killdev') {
    const r = killDevServer();
    if (r.ok) await message.reply(`✅ killed dev server (pid ${r.pid})`);
    else await message.reply(`⚠️ ${r.msg}`);
    return true;
  }

  if (content === '.deploy') {
    const ok = await askApproval(message, 'deploy to Cloudflare', 'npm run deploy');
    if (!ok) return true;
    await message.reply('deploying... (this can take a few min)');
    const r = await runShellCmd('npm run deploy', { timeoutMs: 10 * 60 * 1000 });
    await message.reply(formatShellResult(r));
    return true;
  }

  const pushMatch = content.match(/^\.push(\s+(.*))?$/i);
  if (pushMatch) {
    const args = (pushMatch[2] || '').trim();
    const fullCmd = `git push ${args}`.trim();
    const isForce = /(-f\b|--force\b)/.test(args);
    if (isForce) {
      const ok = await askApproval(message, 'force push', fullCmd);
      if (!ok) return true;
    }
    const r = await runShellCmd(fullCmd, { timeoutMs: 60000 });
    await message.reply(formatShellResult(r));
    return true;
  }

  const runMatch = content.match(/^\.run\s+([\s\S]+)$/i);
  if (runMatch) {
    const cmd = runMatch[1].trim();
    if (isRisky(cmd)) {
      const ok = await askApproval(message, 'risky shell command', cmd);
      if (!ok) return true;
    }
    const r = await runShellCmd(cmd, { timeoutMs: 2 * 60 * 1000 });
    await message.reply(formatShellResult(r));
    return true;
  }

  if (content === '.clip') {
    const r = await runShellCmd('powershell -NoProfile -Command "Get-Clipboard"', { timeoutMs: 5000 });
    const text = r.stdout.trim() || '(empty)';
    await message.reply(`clipboard:\n\`\`\`\n${text.slice(0, 1700)}\n\`\`\``);
    return true;
  }

  const openMatch = content.match(/^\.open\s+(.+)$/i);
  if (openMatch) {
    const target = openMatch[1].trim().replace(/"/g, '');
    await runShellCmd(`powershell -NoProfile -Command "Start-Process '${target}'"`, { timeoutMs: 5000 });
    await message.reply(`✅ opened: ${target}`);
    return true;
  }

  const toastMatch = content.match(/^\.toast\s+([\s\S]+)$/i);
  if (toastMatch) {
    const body = toastMatch[1].trim();
    await showToast('Discord bot', body);
    await message.reply('✅ toast sent');
    return true;
  }

  if (content === '.lock') {
    await runShellCmd('rundll32.exe user32.dll,LockWorkStation', { timeoutMs: 5000 });
    await message.reply('🔒 locked');
    return true;
  }

  if (content === '.unlock') {
    const password = process.env.PC_PASSWORD;
    if (!password) {
      await message.reply('⚠️ `PC_PASSWORD` env var not set. Add it to `.env` and restart bot.');
      return true;
    }
    await message.reply('🔓 unlocking...');
    try {
      await new Promise((resolve, reject) => {
        const py = spawn('python', [path.join(__dirname, 'unlock.py')], {
          shell: false,
          windowsHide: true,
        });
        py.stdin.write(password);
        py.stdin.end();
        let stderr = '';
        py.stderr.on('data', (d) => (stderr += d.toString()));
        py.on('error', reject);
        py.on('close', (code) => {
          if (code !== 0) reject(new Error(stderr.slice(0, 300) || `exit ${code}`));
          else resolve();
        });
      });
      await message.reply('✅ unlocked');
    } catch (e) {
      await message.reply(`unlock fail: ${e.message.slice(0, 300)}`);
    }
    return true;
  }

  if (content === '.sleep') {
    const ok = await askApproval(message, 'sleep PC', 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0');
    if (!ok) return true;
    await message.reply('💤 sleeping...');
    await runShellCmd('rundll32.exe powrprof.dll,SetSuspendState 0,1,0', { timeoutMs: 5000 });
    return true;
  }

  if (content === '.shutdown') {
    const ok = await askApproval(message, 'shutdown PC', 'shutdown /s /t 5');
    if (!ok) return true;
    await message.reply('⏻ shutting down in 5s... use `.run shutdown /a` to abort');
    await runShellCmd('shutdown /s /t 5', { timeoutMs: 5000 });
    return true;
  }

  if (content === '.monitoroff') {
    const ps = '(Add-Type -MemberDefinition \'[DllImport(\\"user32.dll\\")] public static extern int SendMessage(int hWnd, int hMsg, int wParam, int lParam);\' -Name a -Pass)::SendMessage(-1,0x0112,0xF170,2)';
    await runShellCmd(`powershell -NoProfile -Command "${ps}"`, { timeoutMs: 5000 });
    await message.reply('🖥️ monitor off (move mouse / press key to wake)');
    return true;
  }

  const volMatch = content.match(/^\.volume\s+(\d{1,3})$/i);
  if (volMatch) {
    const pct = Math.max(0, Math.min(100, parseInt(volMatch[1])));
    const steps = Math.round(pct / 2);
    const ps = `$wsh = New-Object -ComObject WScript.Shell; 1..50 | ForEach-Object { $wsh.SendKeys([char]174) }; 1..${steps} | ForEach-Object { $wsh.SendKeys([char]175) }`;
    await runShellCmd(`powershell -NoProfile -Command "${ps}"`, { timeoutMs: 10000 });
    await message.reply(`🔊 volume set to ~${pct}%`);
    return true;
  }

  if (content === '.testconfirm' || content === '.test-confirm') {
    const ok = await askApproval(message, 'fake test action', 'echo "this is a fake risky command for testing buttons"');
    await message.reply(ok ? '✅ you clicked Approve (no real action ran)' : '❌ you clicked Cancel (or it timed out)');
    return true;
  }

  if (content.startsWith('.schedule ')) {
    const rest = content.slice('.schedule '.length).trim();
    const sep = rest.indexOf('|');
    if (sep < 0) {
      await message.reply('usage: `.schedule <cron-expr> | <task>`\nexample: `.schedule 0 9 * * * | check git status and yesterday commits summary`\ncron format: minute hour day month weekday (e.g. `0 9 * * *` = 9am daily)');
      return true;
    }
    const cronExpr = rest.slice(0, sep).trim();
    const task = rest.slice(sep + 1).trim();
    if (!cron.validate(cronExpr)) {
      await message.reply(`invalid cron expression: \`${cronExpr}\`. format: \`min hour day month weekday\``);
      return true;
    }
    const all = loadSchedules();
    const id = (Math.max(0, ...all.map(s => s.id || 0)) + 1);
    const schedule = { id, cronExpr, task, createdAt: new Date().toISOString() };
    all.push(schedule);
    saveSchedules(all);
    startSchedule(client, schedule);
    await message.reply(`✅ scheduled #${id}: \`${cronExpr}\` -> ${task}`);
    return true;
  }

  if (content === '.schedules') {
    const all = loadSchedules();
    if (all.length === 0) { await message.reply('no scheduled tasks.'); return true; }
    const list = all.map(s => `**#${s.id}** \`${s.cronExpr}\` -> ${s.task}`).join('\n');
    await message.reply(`scheduled tasks:\n${list}\n\nremove with \`.unschedule <id>\``);
    return true;
  }

  const unscheduleMatch = content.match(/^\.unschedule\s+(\d+)$/);
  if (unscheduleMatch) {
    const id = parseInt(unscheduleMatch[1]);
    const all = loadSchedules();
    const idx = all.findIndex(s => s.id === id);
    if (idx < 0) { await message.reply(`schedule #${id} not found.`); return true; }
    const job = activeJobs.get(id);
    if (job) { job.stop(); activeJobs.delete(id); }
    all.splice(idx, 1);
    saveSchedules(all);
    await message.reply(`✅ removed schedule #${id}`);
    return true;
  }

  // Page scanner: .scan <url>
  const scanMatch = content.match(/^\.scan\s+(\S+)/i);
  if (scanMatch) {
    const url = scanMatch[1].trim();
    if (!/^https?:\/\//i.test(url)) {
      await message.reply('valid URL de (http:// or https://)');
      return true;
    }
    await message.reply(`🔍 scanning ${url}, sec lega...`);
    const outDir = path.join(os.tmpdir(), `scan-${Date.now()}`);
    try {
      const result = await runScanScript(url, outDir);
      if (!result.sections || result.sections.length === 0) {
        await message.reply('no sections captured. site shayad blocked hai ya load nahi hua.');
        return true;
      }
      await message.reply(`📸 ${result.sections.length} sections mile, ek-ek karke bhej raha hu...`);
      for (let i = 0; i < result.sections.length; i++) {
        const s = result.sections[i];
        try {
          // Get one-line description from Claude (vision)
          let desc = s.label;
          try {
            const visionPrompt = `Look at this screenshot at ${s.path} and describe in ONE short line what feature/section this is on the page (e.g., "Hero section with CTA button", "3-column pricing cards", "Footer with social links"). Just the description, nothing else.`;
            const claudeDesc = await runClaude(visionPrompt);
            if (claudeDesc && claudeDesc.trim().length < 200) desc = claudeDesc.trim();
          } catch {}
          const att = new AttachmentBuilder(s.path).setName(`section-${i + 1}.png`);
          await message.reply({ content: `**${i + 1}.** ${desc}`, files: [att] });
        } catch (e) {
          await message.reply(`⚠️ section ${i + 1} fail: ${e.message.slice(0, 200)}`);
        }
      }
      await message.reply(`✅ scan done.`);
      // Cleanup
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
    } catch (e) {
      await message.reply(`❌ scan failed: ${e.message.slice(0, 500)}`);
    }
    return true;
  }

  // Mic streaming
  if (content === '.stream') {
    await startMicStream(client, message);
    return true;
  }
  if (content === '.stopstream' || content === '.stopstream ') {
    await stopMicStream(message);
    return true;
  }

  if (content === '.voice on' || content === '.voice') {
    setTtsEnabled(true);
    await message.reply(`🔊 voice replies ON. each Claude reply will also come as audio (voice: \`${TTS_VOICE}\`).`);
    return true;
  }
  if (content === '.voice off') {
    setTtsEnabled(false);
    await message.reply('🔇 voice replies OFF.');
    return true;
  }
  if (content === '.voice status') {
    await message.reply(`voice: ${isTtsEnabled() ? '🔊 ON' : '🔇 OFF'} (${TTS_VOICE})`);
    return true;
  }

  const updatesMatch = content.match(/^\.updates?\s+(.+)$/i);
  if (updatesMatch) {
    const timeframe = updatesMatch[1].trim();
    const todayISO = new Date().toISOString();
    const liveUrlBase = process.env.LIVE_URL_BASE || '';
    const localhostMappings = process.env.LOCALHOST_MAPPINGS || '';
    const toneReferenceDir = process.env.TONE_REFERENCE_DIR || '';
    const prompt = `.s generate updates for the timeframe described as: "${timeframe}".

🚨 CRITICAL: This task = post EACH feature individually to Discord with screenshot + description. The output is NOT a summary, NOT a list, NOT a markdown report. The output is a SERIES of separate Discord messages (one per feature) each with: short description + live URL + screenshot attached. The final summary at the end is just a 1-line wrap-up.

🚨 NEVER ask the user mid-task. DECIDE and PROCEED. Make sensible judgment calls and execute.

Today's date is ${todayISO}. First, interpret the user's timeframe (it can be any natural language: specific dates, relative like "last 2 weeks", "since monday", "between commit X and Y", a specific date range, etc.). Convert it to a git-compatible --since (and optionally --until) value.

STEPS (follow exactly):
${toneReferenceDir ? `1. FIRST list and read all files inside \`${toneReferenceDir}\` for format/style/tone reference. Match the tone and per-feature granularity you find there.\n2.` : '1.'} Run: git log --since="<your interpretation>" [--until="..."] --oneline --no-merges (and follow up with --stat or diff for context if needed)
${toneReferenceDir ? '3.' : '2.'} For each meaningful commit, look at the diff to understand what changed and which page/feature it touches. Group commits by feature, not by commit hash. Cover EVERY meaningful change, one per block.
${toneReferenceDir ? '4.' : '3.'} For EACH feature, do all of this:
   a. DO NOT run \`npx playwright test\` — that's the test suite, not what we want.
   b. Use a quick screenshot method, in this order of preference:
      - Headless Chrome/Edge: \`chrome --headless --disable-gpu --screenshot="<path>" --window-size=1920,1080 "<url>"\` (or \`msedge\` on Windows)
      - OR a tiny inline Playwright Node script (NOT the test runner): \`node -e "const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage();await p.goto('<url>');await p.screenshot({path:'<path>',fullPage:true});await b.close();})()"\`
   c. Target the LIVE URL${liveUrlBase ? ` (base: ${liveUrlBase})` : ' (set LIVE_URL_BASE env var to substitute localhost with your live domain)'}${localhostMappings ? `. Apply these localhost→live mappings:\n${localhostMappings}` : ''}. Never use localhost in the final post.
   d. ACTIVELY click/interact when the feature requires it: modals, dropdowns, tabs, expand-sections, hover states, form-steps, popups. Use \`page.click(selector)\`, \`page.hover()\`, \`page.fill()\`, \`page.waitForSelector()\` to bring the feature into view BEFORE screenshot.
   e. Save full-page screenshot to \`.discord-uploads/<feature-name>.png\` (relative to bot folder).
   f. Structure each feature in your reply like this:
   \`\`\`
   ### FEATURE_POST_START
   <one-line description>
   <live URL>
   ATTACHMENT: <absolute path to screenshot in .discord-uploads/>
   ### FEATURE_POST_END
   \`\`\`
   The bot detects each FEATURE_POST_START/END block and sends it as a SEPARATE Discord message with the screenshot attached automatically.
   - ATTACHMENT must be an absolute path that exists on disk by the time you finish.
   - Do NOT use markdown image syntax \`![](path)\` — use the ATTACHMENT: line.
   - Separate each feature block with a blank line.

${toneReferenceDir ? '5.' : '4.'} ONLY AFTER all per-feature blocks: append a SHORT 1-line wrap-up at the end like "—— X features, Y commits, range: <date> to <date>"
${toneReferenceDir ? '6.' : '5.'} Progress: 3-4 milestone lines in .live-progress.log (start, halfway, done). No per-tool narration.

🚨 ABSOLUTE RULES:
- NEVER ask the user to clarify mid-task. DECIDE yourself: include everything from the requested timeframe.
- NEVER reply with just a summary. The summary is just the LAST line. The body MUST contain per-feature blocks first.
- If you find 0 features in the timeframe, say so plainly. Otherwise: every feature gets its own block.`;
    queue.push({ message, content: prompt });
    processQueue(client);
    return true;
  }

  if (content === '.help') {
    await message.reply([
      '**Commands** (all use `.` prefix):',
      '',
      '__general__',
      '`.help` - this message',
      '`.status` - bot/session/queue/dev info',
      '`.reset` - clear Claude session, start fresh',
      '`.restart` - restart the bot (use if hung/stuck)',
      '`.voice on/off/status` - toggle TTS audio replies',
      '',
      '__pc control__',
      '`.ss` / `.screenshot` - capture and send PC screen',
      '`.clip` - read PC clipboard',
      '`.open <url|path>` - open URL or file on PC',
      '`.toast <message>` - Windows toast notification',
      '`.lock` - lock Windows screen',
      '`.unlock` - unlock Windows screen (needs `PC_PASSWORD` in .env + Interception driver)',
      '`.sleep` - sleep PC (asks approval)',
      '`.shutdown` - shutdown PC (asks approval)',
      '`.monitoroff` - turn off monitor only',
      '`.volume <0-100>` - set system volume',
      '`.testconfirm` - fake action to test the Approve/Cancel button',
      '',
      '__dev__',
      '`.git` - quick `git status` + last 5 commits',
      '`.dev` - start `npm run dev` in background',
      '`.killdev` - kill background dev server',
      '`.deploy` - `npm run deploy` (asks approval)',
      '`.push [args]` - `git push` (asks approval if `--force`)',
      '`.run <cmd>` - run shell command (asks approval if risky)',
      '',
      '__updates__',
      '`.updates today` / `yesterday` / `last 3 days` / `this week` / `last week` / `4 din ki`',
      'auto-generates per-feature updates from git history with screenshots and live URLs',
      '',
      '__schedules__',
      '`.schedule <cron> | <task>` - schedule recurring (e.g. `0 9 * * *`)',
      '`.schedules` - list scheduled tasks',
      '`.unschedule <id>` - remove scheduled task',
      '',
      '__model override__',
      '`.h <prompt>` - force haiku',
      '`.s <prompt>` - force sonnet',
      '`.o <prompt>` - force opus',
      '',
      'Anything else goes to Claude. Voice + images supported.',
    ].join('\n'));
    return true;
  }

  return false;
}

// ---------- Approval button handler ----------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.user.id !== ALLOWED_USER_ID) {
    await interaction.reply({ content: 'not authorized', ephemeral: true }).catch(() => {});
    return;
  }
  const [action, token] = interaction.customId.split(':');
  const pending = pendingApprovals.get(token);
  if (!pending) {
    await interaction.update({ content: 'approval expired or already handled', components: [] }).catch(() => {});
    return;
  }
  pendingApprovals.delete(token);
  const approved = action === 'approve';
  await interaction.update({
    content: approved ? `✅ approved: **${pending.label}**` : `❌ cancelled: **${pending.label}**`,
    components: [],
  }).catch(() => {});
  pending.resolve(approved);
});

client.login(DISCORD_TOKEN);
