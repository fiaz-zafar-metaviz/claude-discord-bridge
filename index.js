import 'dotenv/config';
import { Client, GatewayIntentBits, Events, AttachmentBuilder } from 'discord.js';
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
const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');

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

==== AGENT MODE (CRITICAL — ${IS_AGENT_MODE ? 'ENABLED' : 'OFF'}) ====
${IS_AGENT_MODE ? `User is OFTEN AWAY FROM PC. You have FULL PC CONTROL via Bash. Behave like an autonomous remote agent:
- NEVER tell user "you have to install X" or "you do Y on your PC". You install it / do it yourself.
- For missing CLI tools on Windows: try in order \`choco install X\`, \`scoop install X\`, \`winget install X\`, \`npm i -g X\`, \`pip install X\`. On Mac: brew. On Linux: apt/yum/dnf. ONLY ask user if all fail.
- For Windows GUI tasks (open browser, click button), use PowerShell automation: \`Start-Process\`, \`Add-Type -AssemblyName System.Windows.Forms\`, \`SendKeys\`.
- For browser automation, use playwright (\`npx playwright codegen\` to record, or write a script).
- For screenshots, use OS-native tools (Windows: PowerShell + System.Drawing; Mac: \`screencapture\`; Linux: \`scrot\`).
- Don't ask permission for installs or file changes or system tweaks. Just do, then briefly report.
- If a task takes 60s+, the bot itself will @ping the user when done so they get a phone notification.` : 'Agent mode disabled. Be more conservative, ask for permission on installs and system changes.'}

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

    const startedAt = Date.now();
    const reply = await runClaude(content);
    const elapsed = Date.now() - startedAt;
    clearInterval(typingInterval);

    const text = (reply || '(empty response)').trim();
    const chunks = chunkText(text);

    const shouldPing = elapsed > PING_AFTER;
    const mention = shouldPing ? `<@${ALLOWED_USER_ID}> ` : '';

    for (let i = 0; i < chunks.length; i++) {
      const prefix = (i === 0 && mention) ? mention : '';
      await message.reply(prefix + chunks[i]);
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

const activeJobs = new Map();

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

// ---------- Screenshot (Windows) ----------
async function takeScreenshot() {
  const tmpFile = path.join(os.tmpdir(), `screenshot-${Date.now()}.png`);
  const platform = process.platform;

  return new Promise((resolve, reject) => {
    let proc;
    if (platform === 'win32') {
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
      proc = spawn('powershell', ['-NoProfile', '-Command', psScript], { windowsHide: true });
    } else if (platform === 'darwin') {
      proc = spawn('screencapture', ['-x', tmpFile]);
    } else {
      // Linux: try scrot first, fallback to gnome-screenshot
      proc = spawn('sh', ['-c', `scrot "${tmpFile}" || gnome-screenshot -f "${tmpFile}"`]);
    }
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(tmpFile)) {
        return reject(new Error(`screenshot failed (${code}): ${stderr.slice(0, 300)}`));
      }
      resolve(tmpFile);
    });
  });
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
    const imageNote = `[User attached ${images.length} image(s) saved to project at .discord-uploads/. Use Read tool to view them:\n${imageList}]`;
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

  // Screenshot command
  if (content === '!screenshot' || content === '!ss') {
    try {
      await message.reply('taking screenshot...');
      const file = await takeScreenshot();
      const att = new AttachmentBuilder(file).setName('screenshot.png');
      await message.reply({ files: [att] });
      try { fs.rmSync(file, { force: true }); } catch {}
    } catch (e) {
      await message.reply(`screenshot failed: ${e.message.slice(0, 300)}`);
    }
    return;
  }

  // Schedule commands
  if (content.startsWith('!schedule ')) {
    const rest = content.slice('!schedule '.length).trim();
    const sep = rest.indexOf('|');
    if (sep < 0) {
      await message.reply('usage: `!schedule <cron-expr> | <task>`\nexample: `!schedule 0 9 * * * | check git status and yesterday commits summary`\ncron format: minute hour day month weekday (e.g. `0 9 * * *` = 9am daily)');
      return;
    }
    const cronExpr = rest.slice(0, sep).trim();
    const task = rest.slice(sep + 1).trim();
    if (!cron.validate(cronExpr)) {
      await message.reply(`invalid cron expression: \`${cronExpr}\``);
      return;
    }
    const all = loadSchedules();
    const id = (Math.max(0, ...all.map(s => s.id || 0)) + 1);
    const schedule = { id, cronExpr, task, createdAt: new Date().toISOString() };
    all.push(schedule);
    saveSchedules(all);
    startSchedule(client, schedule);
    await message.reply(`✅ scheduled #${id}: \`${cronExpr}\` -> ${task}`);
    return;
  }

  if (content === '!schedules') {
    const all = loadSchedules();
    if (all.length === 0) { await message.reply('no scheduled tasks.'); return; }
    const list = all.map(s => `**#${s.id}** \`${s.cronExpr}\` -> ${s.task}`).join('\n');
    await message.reply(`scheduled tasks:\n${list}\n\nremove with \`!unschedule <id>\``);
    return;
  }

  const unscheduleMatch = content.match(/^!unschedule\s+(\d+)$/);
  if (unscheduleMatch) {
    const id = parseInt(unscheduleMatch[1]);
    const all = loadSchedules();
    const idx = all.findIndex(s => s.id === id);
    if (idx < 0) { await message.reply(`schedule #${id} not found.`); return; }
    const job = activeJobs.get(id);
    if (job) { job.stop(); activeJobs.delete(id); }
    all.splice(idx, 1);
    saveSchedules(all);
    await message.reply(`✅ removed schedule #${id}`);
    return;
  }

  if (content === '!help') {
    await message.reply([
      '**Commands:**',
      '`!reset` - clear session, start fresh',
      '`!screenshot` / `!ss` - capture and send PC screenshot',
      '`!schedule <cron> | <task>` - schedule recurring task',
      '`!schedules` - list scheduled tasks',
      '`!unschedule <id>` - remove a scheduled task',
      '`!h <prompt>` / `!s <prompt>` / `!o <prompt>` - force model',
      '`!help` - this message',
      '',
      'Anything else gets sent to Claude. Voice and images supported.',
    ].join('\n'));
    return;
  }

  console.log(`[msg] from ${message.author.tag}: ${content.slice(0, 100)}`);
  queue.push({ message, content });
  processQueue(client);
});

client.login(DISCORD_TOKEN);