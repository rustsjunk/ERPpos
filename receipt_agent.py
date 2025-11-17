"""
Simple Flask-based ESC/POS print agent that writes raw bytes to a serial/USB printer.

Install with: pip install flask pyserial

Usage:
  RECEIPT_SERIAL_PORT=COM3 \
  RECEIPT_SERIAL_BAUD=9600 \
  python receipt_agent.py

Then POST JSON to /print with `text` and optional `hex` sequences.
"""

import logging
import os
from typing import Iterable, Sequence

from flask import Flask, jsonify, request
from serial import Serial, SerialException

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = Flask(__name__)


@app.after_request
def allow_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response

SERIAL_PORT = os.environ.get("RECEIPT_SERIAL_PORT", "COM3")
BAUD_RATE = int(os.environ.get("RECEIPT_SERIAL_BAUD", "9600"))
LINE_FEEDS = int(os.environ.get("RECEIPT_LINE_FEEDS", "2"))
CUT_AFTER_PRINT = os.environ.get("RECEIPT_CUT_AFTER_PRINT", "True").lower() in ("1", "true", "yes")
HOST = os.environ.get("RECEIPT_AGENT_HOST", "127.0.0.1")
PORT = int(os.environ.get("RECEIPT_AGENT_PORT", "5001"))


def _sequence_to_bytes(sequence: Sequence[str]) -> Iterable[bytes]:
    """
    Convert a sequence of hexadecimal strings into bytes for ESC/POS commands.
    """
    for chunk in sequence:
        cleaned = chunk.strip().replace(" ", "")
        if not cleaned:
            continue
        try:
            yield bytes.fromhex(cleaned)
        except ValueError as exc:
            raise ValueError(f"Invalid hex chunk {chunk!r}: {exc}") from exc


def _write_text(ser: Serial, text: str) -> None:
    if not text:
        return
    ser.write(text.encode("ascii", errors="ignore"))


def _write_custom_hex(ser: Serial, hex_commands: Sequence[str]) -> None:
    if not hex_commands:
        return
    for data in _sequence_to_bytes(hex_commands):
        ser.write(data)


def _write_cut(ser: Serial) -> None:
    # ESC/POS full cut: GS V 0
    ser.write(b"\x1D\x56\x00")


def _with_serial(func):
    def wrapper(*args, **kwargs):
        try:
            with Serial(SERIAL_PORT, BAUD_RATE, timeout=1) as ser:
                return func(ser, *args, **kwargs)
        except SerialException:
            logging.exception("Serial error")
            raise
    return wrapper


@app.route("/print", methods=["POST", "OPTIONS"])
def print_receipt():
    if request.method == "OPTIONS":
        return jsonify(ok=True)

    payload = request.get_json(force=True) or {}
    text = payload.get("text", "")
    hex_commands = payload.get("hex", [])
    if isinstance(hex_commands, str):
        hex_commands = [hex_commands]
    elif not isinstance(hex_commands, list):
        hex_commands = list(hex_commands)
    extra_line_feeds = int(payload.get("line_feeds", LINE_FEEDS))
    cut = payload.get("cut", CUT_AFTER_PRINT)

    @_with_serial
    def _send(ser: Serial) -> None:
        _write_text(ser, text)
        _write_custom_hex(ser, hex_commands)
        if extra_line_feeds > 0:
            ser.write(b"\n" * extra_line_feeds)
        if cut:
            _write_cut(ser)

    try:
        _send()
    except ValueError as exc:
        logging.warning("Bad hex payload: %s", exc)
        return jsonify(ok=False, error=str(exc)), 400
    except SerialException as exc:
        return jsonify(ok=False, error=str(exc)), 500

    logging.info("Printed receipt; text length=%d hex commands=%d", len(text), len(hex_commands))
    return jsonify(ok=True)


@app.get("/health")
def health():
    return "ok", 200


if __name__ == "__main__":
    logging.info(
        "Starting receipt agent on http://%s:%d printing to %s@%d",
        HOST,
        PORT,
        SERIAL_PORT,
        BAUD_RATE,
    )
    # Avoid Flask reloader to keep serial port exclusive
    app.run(host=HOST, port=PORT, debug=False, use_reloader=False)
