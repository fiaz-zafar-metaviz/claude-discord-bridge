"""
Text to speech using edge-tts (free MS Azure Neural voices, no API key).
Usage: python tts.py <output.mp3> "<text>" [voice]
Default voice: en-US-AriaNeural. Other good ones:
  en-US-GuyNeural, en-IN-PrabhatNeural (Indian English), hi-IN-MadhurNeural (Hindi)
  en-GB-SoniaNeural, en-AU-NatashaNeural
Full list: edge-tts --list-voices
"""
import sys
import asyncio
import os

if len(sys.argv) < 3:
    print("ERROR: usage: python tts.py <output-file> <text> [voice]", file=sys.stderr)
    sys.exit(1)

output_file = sys.argv[1]
text = sys.argv[2]
voice = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("TTS_VOICE", "en-US-AriaNeural")

try:
    import edge_tts
except ImportError:
    print("ERROR: edge-tts not installed. Run: pip install edge-tts", file=sys.stderr)
    sys.exit(1)

async def main():
    # Strip markdown for cleaner audio
    clean = text
    for prefix in ['#', '*', '`', '_']:
        clean = clean.replace(prefix, '')
    # Limit length to avoid huge audio files
    if len(clean) > 3000:
        clean = clean[:3000] + ". output truncated."
    communicate = edge_tts.Communicate(clean, voice)
    await communicate.save(output_file)
    print(f"[tts] saved to {output_file}", file=sys.stderr)

asyncio.run(main())
