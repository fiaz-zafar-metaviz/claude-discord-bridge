"""
Transcribe an audio file to text using faster-whisper.
Usage: python transcribe.py <audio-file-path>
Prints transcribed text to stdout.

Model size controlled by WHISPER_MODEL env var (default: base).
Options: tiny, base, small, medium, large-v3
- tiny:  75MB, fastest, lowest accuracy
- base:  142MB, balanced (default)
- small: 466MB, better for accents/Hinglish
- medium: 1.4GB, very accurate
- large-v3: 2.9GB, best
"""
import sys
import os

if len(sys.argv) < 2:
    print("ERROR: audio file path required", file=sys.stderr)
    sys.exit(1)

audio_path = sys.argv[1]

if not os.path.exists(audio_path):
    print(f"ERROR: file not found: {audio_path}", file=sys.stderr)
    sys.exit(1)

try:
    from faster_whisper import WhisperModel
except ImportError:
    print("ERROR: faster-whisper not installed. Run: pip install faster-whisper", file=sys.stderr)
    sys.exit(1)

model_size = os.environ.get("WHISPER_MODEL", "base")
device = os.environ.get("WHISPER_DEVICE", "cpu")
compute_type = os.environ.get("WHISPER_COMPUTE", "int8")

print(f"[whisper] loading model={model_size} device={device}", file=sys.stderr)

model = WhisperModel(model_size, device=device, compute_type=compute_type)

print(f"[whisper] transcribing {audio_path}", file=sys.stderr)

segments, info = model.transcribe(
    audio_path,
    beam_size=5,
    vad_filter=True,
)

print(f"[whisper] detected language={info.language} (prob={info.language_probability:.2f})", file=sys.stderr)

text_parts = []
for segment in segments:
    text_parts.append(segment.text.strip())

result = " ".join(text_parts).strip()
print(result)
