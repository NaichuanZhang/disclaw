#!/usr/bin/env python3
"""
One-shot local transcription using NVIDIA's Parakeet ASR model via NeMo.

Invoked by src/audio/local-transcribe.ts as a subprocess. Expects a 16kHz
mono WAV file path as its first argument. Prints a single line of JSON to
stdout on success: {"text": "..."}. On failure, prints JSON with an "error"
key to stderr and exits non-zero.

This keeps all audio processing fully local/offline (after the one-time
model download from Hugging Face on first use).
"""
import argparse
import json
import sys


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path", help="Path to a 16kHz mono WAV/FLAC file")
    parser.add_argument(
        "--model",
        default="nvidia/parakeet-tdt-0.6b-v2",
        help="NeMo/Hugging Face model name (default: nvidia/parakeet-tdt-0.6b-v2)",
    )
    parser.add_argument(
        "--timestamps",
        action="store_true",
        help="Include word-level timestamps in the output JSON",
    )
    args = parser.parse_args()

    import nemo.collections.asr as nemo_asr  # imported lazily so --help works without NeMo

    asr_model = nemo_asr.models.ASRModel.from_pretrained(model_name=args.model)
    output = asr_model.transcribe([args.audio_path], timestamps=args.timestamps)

    result = output[0]
    text = getattr(result, "text", None)
    if text is None:
        text = str(result)

    payload = {"text": text}

    if args.timestamps:
        ts = getattr(result, "timestamp", None)
        if ts is not None:
            try:
                payload["timestamps"] = ts.get("word", ts) if isinstance(ts, dict) else ts
            except Exception:
                pass

    print(json.dumps(payload))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - surface any failure as JSON on stderr
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
