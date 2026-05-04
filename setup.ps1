# claude-discord-bridge - Auto Setup Script
# Asks for: Discord token, your User ID, your Channel ID, your project path
# Does the rest: install deps, configure .env, install pm2 + auto-startup

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

function Write-Banner($text) {
    Write-Host ""
    Write-Host "===========================================================" -ForegroundColor Cyan
    Write-Host "  $text" -ForegroundColor Cyan
    Write-Host "===========================================================" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step($num, $text) {
    Write-Host ""
    Write-Host "[Step $num] $text" -ForegroundColor Yellow
    Write-Host ""
}

function Pause-ForUser($msg = "Press Enter when done...") {
    Write-Host $msg -ForegroundColor Magenta
    Read-Host | Out-Null
}

function Test-Command($name) {
    return $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Banner "claude-discord-bridge - Auto Setup"

# ---------- Prerequisite check ----------
Write-Host "Checking prerequisites..." -ForegroundColor Gray

if (-not (Test-Command "node")) {
    Write-Host "ERROR: Node.js is not installed. Get it from https://nodejs.org" -ForegroundColor Red
    exit 1
}
if (-not (Test-Command "npm")) {
    Write-Host "ERROR: npm not found. Reinstall Node.js properly." -ForegroundColor Red
    exit 1
}
if (-not (Test-Command "claude")) {
    Write-Host "WARNING: Claude Code CLI not found. The bot won't work without it." -ForegroundColor Yellow
    Write-Host "         Install from: https://docs.claude.com/claude-code (or use npm: 'npm i -g @anthropic-ai/claude-code')" -ForegroundColor Yellow
    Write-Host "         Then run: claude auth login" -ForegroundColor Yellow
    $ans = Read-Host "Continue anyway? (y/n)"
    if ($ans -ne "y") { exit 1 }
}

$pythonAvailable = Test-Command "python"
if ($pythonAvailable) {
    Write-Host "OK - Node, npm, claude, python detected." -ForegroundColor Green
} else {
    Write-Host "OK - Node, npm, claude detected." -ForegroundColor Green
    Write-Host "WARNING: Python not found. Voice message transcription will not work." -ForegroundColor Yellow
    Write-Host "         For voice support, install Python 3.8+ from https://www.python.org" -ForegroundColor Yellow
}

# ---------- Step 1: Project Path ----------
Write-Step "1 / 4" "Project path"

Write-Host "Bot will run 'claude' from your project's root folder. Provide the absolute path."
Write-Host "Example Windows: C:\Users\you\projects\my-app"
Write-Host "Example Mac/Linux: /home/you/projects/my-app"
Write-Host ""

$projectDir = Read-Host "Project root path"
if ([string]::IsNullOrWhiteSpace($projectDir)) {
    Write-Host "ERROR: Project path is required." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $projectDir)) {
    Write-Host "WARNING: Path doesn't exist: $projectDir" -ForegroundColor Yellow
    $ans = Read-Host "Continue anyway? (y/n)"
    if ($ans -ne "y") { exit 1 }
}

# Normalize backslashes to forward (works on both)
$projectDir = $projectDir.Replace("\", "/").TrimEnd("/")

# ---------- Step 2: Discord Bot Token ----------
Write-Step "2 / 4" "Discord Bot Token"

Write-Host "1. Open https://discord.com/developers/applications in browser"
Write-Host "2. Top right 'New Application', pick a name (avoid 'Claude' - trademark blocked), Create"
Write-Host "3. Left sidebar 'Bot'"
Write-Host "4. 'Reset Token', copy it (only shown once)"
Write-Host "5. Same Bot page, scroll to 'Privileged Gateway Intents':"
Write-Host "   - Toggle 'MESSAGE CONTENT INTENT' ON"
Write-Host ""
Write-Host "   *** IMPORTANT: Click the green 'Save Changes' button at the bottom! ***" -ForegroundColor Red
Write-Host "   *** Without saving, the bot will crash with 'Used disallowed intents' ***" -ForegroundColor Red
Write-Host ""

$token = Read-Host "Paste bot token here"
if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Host "ERROR: Token is empty." -ForegroundColor Red
    exit 1
}

# ---------- Step 2.5: Invite bot to server ----------
Write-Step "2.5 / 4" "Invite bot to your server"

Write-Host "On the same Discord Developer page:"
Write-Host "1. Left sidebar 'OAuth2', then 'URL Generator'"
Write-Host "2. Scopes: tick 'bot'"
Write-Host "3. Bot Permissions: tick 'Send Messages', 'Read Message History', 'View Channels'"
Write-Host "4. Copy the generated URL at the bottom, paste in browser, pick your server, Authorize"
Write-Host ""
Write-Host "   Don't have a server? In Discord, click '+' icon in left sidebar, 'Create My Own', name it, Create"
Write-Host ""

Pause-ForUser "Bot added to your server? Press Enter to continue..."

# ---------- Step 3: User ID ----------
Write-Step "3 / 4" "Your Discord User ID"

Write-Host "1. Discord Settings (gear icon, bottom left), 'Advanced', toggle 'Developer Mode' ON"
Write-Host "2. Right-click your username (in any chat or member list), 'Copy User ID'"
Write-Host ""

$userId = Read-Host "Paste your User ID"
if ([string]::IsNullOrWhiteSpace($userId)) {
    Write-Host "ERROR: User ID is empty." -ForegroundColor Red
    exit 1
}

# ---------- Step 4: Channel ID ----------
Write-Step "4 / 4" "Private Channel ID"

Write-Host "1. In your server, create a private channel (only you can access)"
Write-Host "   - Right-click server, 'Create Channel', name it (e.g. 'claude-bot')"
Write-Host "   - Check 'Private Channel'"
Write-Host "2. Right-click that channel, 'Copy Channel ID'"
Write-Host ""

$channelId = Read-Host "Paste Channel ID"
if ([string]::IsNullOrWhiteSpace($channelId)) {
    Write-Host "ERROR: Channel ID is empty." -ForegroundColor Red
    exit 1
}

# ---------- Write .env ----------
Write-Banner "Saving configuration..."

$envContent = @"
DISCORD_TOKEN=$token
ALLOWED_USER_ID=$userId
ALLOWED_CHANNEL_ID=$channelId
CLAUDE_PROJECT_DIR=$projectDir
CLAUDE_PERMISSION_MODE=bypassPermissions
CLAUDE_DEFAULT_MODEL=haiku
CLAUDE_HEAVY_MODEL=sonnet
WHISPER_MODEL=base
WHISPER_DEVICE=cpu
WHISPER_COMPUTE=int8
"@

Set-Content -Path "$scriptDir\.env" -Value $envContent -Encoding UTF8 -NoNewline
Write-Host "OK - .env file created." -ForegroundColor Green

# ---------- npm install ----------
Write-Banner "Installing dependencies..."

if (-not (Test-Path "$scriptDir\node_modules")) {
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: npm install failed." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "node_modules already exists - skipping." -ForegroundColor Gray
}

# ---------- Install Python deps for voice transcription ----------
if ($pythonAvailable) {
    Write-Banner "Setting up voice transcription (faster-whisper)..."
    pip show faster-whisper 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Installing faster-whisper (~100MB download, may take a few minutes)..." -ForegroundColor Gray
        pip install faster-whisper
        if ($LASTEXITCODE -ne 0) {
            Write-Host "WARNING: faster-whisper install failed. Voice messages will be skipped." -ForegroundColor Yellow
        } else {
            Write-Host "OK - faster-whisper installed." -ForegroundColor Green
            Write-Host "      First voice message will auto-download Whisper model (~150MB)" -ForegroundColor Gray
        }
    } else {
        Write-Host "faster-whisper already installed." -ForegroundColor Gray
    }
}

# ---------- Install pm2 globally ----------
Write-Banner "Installing PM2 (for auto-startup)..."

if (-not (Test-Command "pm2")) {
    npm install -g pm2
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: pm2 install failed. Run PowerShell as Administrator." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "PM2 already installed." -ForegroundColor Gray
}

# ---------- Install pm2-windows-startup ----------
if (-not (Test-Command "pm2-startup")) {
    Write-Host "Installing pm2-windows-startup..." -ForegroundColor Gray
    npm install -g pm2-windows-startup
    if ($LASTEXITCODE -ne 0) {
        Write-Host "WARNING: pm2-windows-startup install failed. Auto-startup will not be configured." -ForegroundColor Yellow
    }
}

# ---------- Stop existing process if running ----------
$existing = pm2 list | Select-String "discord-claude"
if ($existing) {
    Write-Host "Removing previous discord-claude process..." -ForegroundColor Gray
    pm2 delete discord-claude 2>&1 | Out-Null
}

# ---------- Start with pm2 ----------
Write-Banner "Starting bot..."

pm2 start index.js --name discord-claude
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: pm2 start failed." -ForegroundColor Red
    exit 1
}

pm2 save | Out-Null

# ---------- Setup auto-startup ----------
if (Test-Command "pm2-startup") {
    Write-Host "Configuring auto-startup..." -ForegroundColor Gray
    pm2-startup install 2>&1 | Out-Null
}

# ---------- Wait + read session UUID ----------
Start-Sleep -Seconds 3
$sessionFile = "$scriptDir\.claude-session-id"
$sessionId = if (Test-Path $sessionFile) { (Get-Content $sessionFile).Trim() } else { "(not yet generated, check pm2 logs)" }

# ---------- Done ----------
Write-Banner "DONE - Bot is running"

Write-Host "Claude Session UUID:" -ForegroundColor Green
Write-Host "  $sessionId" -ForegroundColor White
Write-Host ""
Write-Host "Continue this conversation in terminal:" -ForegroundColor Green
Write-Host "  cd $projectDir" -ForegroundColor White
Write-Host "  claude --resume $sessionId" -ForegroundColor White
Write-Host ""
Write-Host "Daily commands:" -ForegroundColor Green
Write-Host "  pm2 status                    (check if bot is running)"
Write-Host "  pm2 logs discord-claude       (live logs)"
Write-Host "  pm2 restart discord-claude    (after code change)"
Write-Host "  pm2 stop discord-claude       (stop)"
Write-Host "  pm2 start discord-claude      (restart if stopped)"
Write-Host ""
Write-Host "Now send a message in your private Discord channel - the bot will reply!" -ForegroundColor Cyan
Write-Host ""