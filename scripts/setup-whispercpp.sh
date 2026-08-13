#!/usr/bin/env bash
#
# One-time setup for the local whisper.cpp transcription backend.
#
# Requires only: git, cmake, g++/make, ffmpeg, curl — no Python, no pip,
# no root. This exists because the NeMo/Parakeet backend needs a working
# Python packaging stack, which some hosts simply don't have (e.g. a Jetson
# with no pip/ensurepip and no passwordless sudo).
#
# Usage:
#   ./scripts/setup-whispercpp.sh [model]
#
# `model` defaults to base.en. Other useful values: tiny.en (fastest),
# small.en (more accurate, ~3x slower), base (multilingual).

set -euo pipefail

MODEL="${1:-base.en}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASR_DIR="$REPO_ROOT/data/asr/whisper.cpp"

echo "==> whisper.cpp setup (model: $MODEL)"

for tool in git cmake make ffmpeg; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool '$tool' not found on PATH." >&2
    exit 1
  fi
done

if [ ! -d "$ASR_DIR/.git" ]; then
  echo "==> Cloning whisper.cpp into $ASR_DIR"
  mkdir -p "$(dirname "$ASR_DIR")"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$ASR_DIR"
else
  echo "==> whisper.cpp already cloned, reusing $ASR_DIR"
fi

cd "$ASR_DIR"

echo "==> Configuring build"
cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF

echo "==> Building (this takes a few minutes)"
cmake --build build -j"$(nproc)" --config Release

BIN="$ASR_DIR/build/bin/whisper-cli"
if [ ! -x "$BIN" ]; then
  echo "ERROR: build finished but $BIN is missing." >&2
  exit 1
fi

MODEL_FILE="$ASR_DIR/models/ggml-${MODEL}.bin"
if [ ! -f "$MODEL_FILE" ]; then
  echo "==> Downloading model $MODEL"
  ./models/download-ggml-model.sh "$MODEL"
else
  echo "==> Model already present: $MODEL_FILE"
fi

echo "==> Smoke test"
ffmpeg -y -loglevel error -i samples/jfk.wav -ar 16000 -ac 1 -c:a pcm_s16le /tmp/whispercpp-smoke.wav
"$BIN" -m "$MODEL_FILE" -f /tmp/whispercpp-smoke.wav -nt -np
rm -f /tmp/whispercpp-smoke.wav

echo
echo "==> Done."
echo "    bin:   $BIN"
echo "    model: $MODEL_FILE"
echo "    Override with WHISPER_CPP_BIN / WHISPER_CPP_MODEL if needed."
