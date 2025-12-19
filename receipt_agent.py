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
from datetime import datetime
from typing import Iterable, Sequence

from flask import Flask, jsonify, request
from serial import Serial, SerialException

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = Flask(__name__)


def _code39_sanitize(value: str) -> str:
    """
    Code 39 allowed chars: 0-9 A-Z space $ % * + - . / 
    We'll uppercase and strip anything else.
    """
    allowed = set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./")
    v = (value or "").upper()
    out = "".join(c for c in v if c in allowed)
    return out or "INV0001"


def _escpos_barcode_code39_hex(value: str, height: int = 80, width: int = 2, hri: int = 2) -> list[str]:
    """
    Returns hex command chunks for printing a Code 39 barcode.
    - height: 1..255
    - width: 2..6 typically
    - hri: 0=none, 1=above, 2=below, 3=both
    """
    v = _code39_sanitize(value)
    data = v.encode("ascii", errors="ignore")

    cmds = []

    # Initialize (ESC @)
    cmds.append("1b 40")

    # Barcode params
    cmds.append(f"1d 68 {height:02x}")  # GS h n
    cmds.append(f"1d 77 {width:02x}")   # GS w n
    cmds.append(f"1d 48 {hri:02x}")     # GS H n

    # Print Code39: GS k m d1..dk NUL (for m=4)
    # Format: 1D 6B 04 <data bytes> 00
    cmds.append(("1d 6b 04 " + data.hex(" ") + " 00").strip())

    return cmds


def _format_amount_label(amount: object, currency: str | None = "GBP") -> str:
    try:
        value = float(amount)
    except (TypeError, ValueError):
        if amount is None:
            return ""
        return str(amount)
    unit = (currency or "GBP").strip() or "GBP"
    return f"{unit.upper()} {value:,.2f}"


def _terms_payload(payload) -> list[str]:
    terms = payload.get("terms")
    if isinstance(terms, str):
        terms = [terms]
    if isinstance(terms, (list, tuple)):
        cleaned = [str(entry).strip() for entry in terms if str(entry).strip()]
        if cleaned:
            return cleaned
    return [
        "Valid for 12 months from issue.",
        "Treat like cash; lost vouchers cannot be replaced.",
        "Redeemable in-store for merchandise only.",
    ]


def _normalized_lines(value) -> list[str]:
    if not value:
        return []
    if isinstance(value, str):
        source = value.splitlines()
    elif isinstance(value, (list, tuple)):
        source = value
    else:
        source = [value]
    cleaned = []
    for entry in source:
        try:
            text = str(entry).strip()
        except Exception:
            text = ""
        if text:
            cleaned.append(text)
    return cleaned



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
    data = text.encode("ascii", errors="ignore")
    # DEBUG: log as hex
    logging.info("[AGENT] TEXT HEX: %s", data.hex(" "))
    ser.write(data)



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
    cleaned_preview = text.strip().replace("\n", "\\n")
    logging.info(
        "Preparing receipt: text len=%d snippet=%s",
        len(text),
        cleaned_preview[:120]
    )
    if hex_commands:
        logging.info("Printing extra hex commands: %s", hex_commands)

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


@app.route("/print-voucher", methods=["POST", "OPTIONS"])
def print_voucher():
    if request.method == "OPTIONS":
        return jsonify(ok=True)

    payload = request.get_json(force=True) or {}
    voucher_code = payload.get("voucher_code") or payload.get("voucher_name") or ""
    amount = payload.get("amount")
    title = payload.get("title", "GIFT VOUCHER").strip() or "GIFT VOUCHER"
    currency = payload.get("currency", "GBP")
    issue_date = payload.get("issue_date")
    if not issue_date:
        issue_date = datetime.utcnow().strftime("%Y-%m-%d")
    cashier = (payload.get("cashier") or "").strip()
    voucher_name = payload.get("voucher_name") or payload.get("voucher_label") or ""
    location = payload.get("till_number") or payload.get("till") or payload.get("location")
    terms_lines = _terms_payload(payload)
    header_lines = _normalized_lines(payload.get("header_lines")) or _normalized_lines(payload.get("header"))
    footer_lines = _normalized_lines(payload.get("footer_lines")) or _normalized_lines(payload.get("footer"))
    fun_raw = payload.get("fun_line") or "Thanks for sharing the joy!"
    fun_line = str(fun_raw).strip()

    safe_code = _code39_sanitize(voucher_code)
    display_name = (voucher_name or safe_code).strip() or safe_code
    amount_label = payload.get("amount_label") or _format_amount_label(amount, currency)
    esc = "\x1B"
    center_on = f"{esc}\x61\x01"
    center_off = f"{esc}\x61\x00"
    big_on = f"{esc}!\x38"
    huge_on = "\x1D!\x33"
    huge_off = "\x1D!\x00"
    normal = f"{esc}!\x00"
    bold_on = f"{esc}\x45\x01"
    bold_off = f"{esc}\x45\x00"
    line = "-" * 32

    def center(text: str) -> str:
        return f"{center_on}{text}{center_off}\n"

    lines = [f"{esc}@"]  # reset printer
    if header_lines:
        for entry in header_lines:
            lines.append(center(entry))
        lines.append("\n")
    lines.append(center(f"{big_on}{title.upper()}{normal}"))
    lines.append(center(f"{bold_on}{display_name}{bold_off}"))
    lines.append(center(line))
    lines.append(f"Voucher: {safe_code}\n")
    if location:
        lines.append(f"Location: {location}\n")
    if cashier:
        lines.append(f"Cashier: {cashier}\n")
    if issue_date:
        lines.append(f"Issued: {issue_date}\n")
    if amount_label:
        lines.append("\n")
        lines.append(center(f"{huge_on}{amount_label}{huge_off}"))
        lines.append(center(""))
    lines.append("\nScan barcode to redeem\n\n")
    if fun_line:
        lines.append(center(fun_line))
        lines.append("\n")
    if terms_lines:
        lines.append("T&C's:\n")
        for entry in terms_lines:
            lines.append(f"- {entry}\n")
        lines.append("\n")
    if footer_lines:
        for entry in footer_lines:
            lines.append(center(entry))
        lines.append("\n")

    text = "".join(lines)

    hex_commands = _escpos_barcode_code39_hex(safe_code, height=80, width=2, hri=2)

    # You can also let caller override cut/feeds
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
        return jsonify(ok=False, error=str(exc)), 400
    except SerialException as exc:
        return jsonify(ok=False, error=str(exc)), 500

    return jsonify(ok=True, voucher_code=safe_code)



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
