"""
Simple Flask-based ESC/POS print agent that writes raw bytes to a printer.

Two modes:
  1. Windows printer name (for USB printers via APD driver):
       RECEIPT_PRINTER_NAME="EPSON TM-T20III Receipt" python receipt_agent.py

  2. Direct serial/COM port:
       RECEIPT_SERIAL_PORT=COM3 RECEIPT_SERIAL_BAUD=38400 python receipt_agent.py

Then POST JSON to /print with `text` and optional `hex` sequences.
"""

import io
import logging
import os
import re
import urllib.request
from contextlib import contextmanager
from datetime import datetime
from typing import Iterable, Sequence

from flask import Flask, jsonify, request

try:
    from serial import Serial, SerialException
    _SERIAL_AVAILABLE = True
except ImportError:
    _SERIAL_AVAILABLE = False
    SerialException = OSError

try:
    from PIL import Image as _PILImage
    _PIL_AVAILABLE = True
except ImportError:
    _PIL_AVAILABLE = False
    logging.warning("Pillow not installed — picking note images will be skipped")

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

    # Center alignment (ESC a 1) — must be set before the barcode command
    cmds.append("1b 61 01")
    # Barcode params
    cmds.append(f"1d 68 {height:02x}")  # GS h n
    cmds.append(f"1d 77 {width:02x}")   # GS w n
    cmds.append(f"1d 48 {hri:02x}")     # GS H n

    # Print Code39: GS k m d1..dk NUL (for m=4)
    # Format: 1D 6B 04 <data bytes> 00
    cmds.append(("1d 6b 04 " + data.hex(" ") + " 00").strip())
    # Restore left alignment after barcode
    cmds.append("1b 61 00")

    return cmds


def _escpos_image_bytes(image_url: str, max_width: int = 120) -> bytes:
    """Download image_url and return ESC/POS GS v 0 raster bitmap bytes.

    Resizes to max_width dots wide (capped square), converts to 1-bit with
    Floyd-Steinberg dithering so it looks reasonable on thermal paper.
    Returns empty bytes if PIL is unavailable or anything goes wrong.
    """
    if not _PIL_AVAILABLE or not image_url:
        return b""
    try:
        req = urllib.request.Request(image_url, headers={"User-Agent": "ERPPos/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            raw_data = resp.read()

        img = _PILImage.open(io.BytesIO(raw_data)).convert("RGB").convert("L")

        # Resize to max_width, cap height to square to avoid huge tall images
        w, h = img.size
        if w > max_width:
            h = max(1, int(h * max_width / w))
            w = max_width
            img = img.resize((w, h), _PILImage.LANCZOS)
        if h > max_width:
            w = max(1, int(w * max_width / h))
            img = img.resize((w, max_width), _PILImage.LANCZOS)
            w, h = img.size

        # 1-bit with Floyd-Steinberg dithering (Pillow default for convert("1"))
        img = img.convert("1")

        # Pack pixels into ESC/POS raster format (MSB first, 1=black dot)
        width_bytes = (w + 7) // 8
        px = img.load()
        raster = bytearray()
        for y in range(h):
            for bx in range(width_bytes):
                byte = 0
                for bit in range(8):
                    x = bx * 8 + bit
                    if x < w and not px[x, y]:   # 0 / False = black
                        byte |= (0x80 >> bit)
                raster.append(byte)

        # GS v 0 — raster bit image: 1D 76 30 m xL xH yL yH [data]
        xL = width_bytes & 0xFF
        xH = (width_bytes >> 8) & 0xFF
        yL = h & 0xFF
        yH = (h >> 8) & 0xFF
        return bytes([0x1D, 0x76, 0x30, 0x00, xL, xH, yL, yH]) + bytes(raster)
    except Exception as exc:
        logging.debug("[picking-note] image convert failed (%s): %s", image_url, exc)
        return b""


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
PRINTER_NAME = os.environ.get("RECEIPT_PRINTER_NAME", "").strip()


class _Win32Printer:
    """Thin wrapper around a win32print job that exposes .write() like Serial."""
    def __init__(self, handle):
        self._h = handle

    def write(self, data: bytes) -> None:
        import win32print
        win32print.WritePrinter(self._h, data)


@contextmanager
def _open_printer():
    """Open either a Windows printer (by name) or a serial port."""
    if PRINTER_NAME:
        import win32print
        hprinter = win32print.OpenPrinter(PRINTER_NAME)
        try:
            win32print.StartDocPrinter(hprinter, 1, ("Receipt", None, "RAW"))
            try:
                win32print.StartPagePrinter(hprinter)
                yield _Win32Printer(hprinter)
                win32print.EndPagePrinter(hprinter)
            finally:
                win32print.EndDocPrinter(hprinter)
        finally:
            win32print.ClosePrinter(hprinter)
    else:
        with Serial(SERIAL_PORT, BAUD_RATE, timeout=1) as ser:
            yield ser


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


def _with_printer(func):
    def wrapper(*args, **kwargs):
        try:
            with _open_printer() as printer:
                return func(printer, *args, **kwargs)
        except Exception:
            logging.exception("Printer error")
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

    @_with_printer
    def _send(printer) -> None:
        _write_text(printer, text)
        _write_custom_hex(printer, hex_commands)
        if extra_line_feeds > 0:
            printer.write(b"\n" * extra_line_feeds)
        if cut:
            _write_cut(printer)

    try:
        _send()
    except ValueError as exc:
        logging.warning("Bad hex payload: %s", exc)
        return jsonify(ok=False, error=str(exc)), 400
    except Exception as exc:
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
    value_big_on = "\x1D!\x22"
    huge_off = "\x1D!\x00"
    normal = f"{esc}!\x00"
    bold_on = f"{esc}\x45\x01"
    bold_off = f"{esc}\x45\x00"
    line = "-" * 32

    def center(text: str) -> str:
        return f"{center_on}{text}{center_off}\n"

    lines = [f"{esc}@"]  # reset printer
    if header_lines:
        for idx, entry in enumerate(header_lines):
            if idx == 0:
                lines.append(center(f"{bold_on}{big_on}{entry}{normal}{bold_off}"))
            else:
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
        lines.append(center(f"{value_big_on}{amount_label}{huge_off}"))
        lines.append(center(""))
    lines.append(center("Scan barcode to redeem"))
    lines.append("\n")
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

    @_with_printer
    def _send(printer) -> None:
        _write_text(printer, text)
        _write_custom_hex(printer, hex_commands)
        if extra_line_feeds > 0:
            printer.write(b"\n" * extra_line_feeds)
        if cut:
            _write_cut(printer)

    try:
        _send()
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    except Exception as exc:
        return jsonify(ok=False, error=str(exc)), 500

    return jsonify(ok=True, voucher_code=safe_code)



@app.route("/print-picking-note", methods=["POST", "OPTIONS"])
def print_picking_note():
    """Print a picking note for a web (Shopify) order.

    Expected payload:
      order_number  - e.g. "#1001"
      customer_name - customer display name
      date          - order date string
      items         - list of dicts with keys:
                        item_name, item_code, qty, barcode,
                        colour, size, style_code  (all optional)
    """
    if request.method == "OPTIONS":
        return jsonify(ok=True)

    payload = request.get_json(force=True) or {}
    order_number = payload.get("order_number", "")
    customer_name = payload.get("customer_name", "")
    items = payload.get("items", [])

    date = payload.get("date", "")
    logging.info("[picking-note] order=%s customer=%s items=%d", order_number, customer_name, len(items))

    @_with_printer
    def _send(printer) -> None:
        ESC = "\x1b"
        GS  = "\x1d"
        center   = f"{ESC}\x61\x01"   # ESC a 1 — centre align
        left     = f"{ESC}\x61\x00"   # ESC a 0 — left align
        dbl      = f"{ESC}!\x10"      # ESC ! 0x10 — double height
        dbl_wide = f"{ESC}!\x30"      # ESC ! 0x30 — double height + double width
        bold_on  = f"{ESC}\x45\x01"
        bold_off = f"{ESC}\x45\x00"
        normal   = f"{ESC}!\x00"

        sep  = "=" * 32
        thin = "-" * 32

        # ── Header ────────────────────────────────────────────────────────────
        _write_text(printer, f"{center}{sep}\n")
        _write_text(printer, f"{dbl_wide}  PICKING NOTE{normal}\n")
        _write_text(printer, f"{center}{sep}\n")

        # ── Order info (double-height for readability) ─────────────────────
        _write_text(printer, f"{left}{dbl}{bold_on}Order:{normal}{bold_off}    {order_number}\n")
        _write_text(printer, f"{dbl}{bold_on}Customer:{normal}{bold_off} {customer_name}\n")
        if date:
            _write_text(printer, f"{dbl}{bold_on}Date:{normal}{bold_off}     {date}\n")
        _write_text(printer, f"{center}{sep}\n{left}")

        # ── Items ──────────────────────────────────────────────────────────
        for item in items:
            name       = (item.get("item_name") or item.get("item_code") or "")[:28]
            barcode    = (item.get("barcode") or item.get("item_code") or "").strip()
            qty        = item.get("qty", 1)
            colour     = (item.get("colour") or "").strip()
            size       = (item.get("size") or "").strip()
            style_code = (item.get("style_code") or "").strip()
            brand      = (item.get("brand") or "").strip()
            item_group = (item.get("item_group") or "").strip()

            _write_text(printer, f"{thin}\n")
            # Item name — double height + bold
            _write_text(printer, f"{dbl}{bold_on}{name}{bold_off}{normal}\n")
            if brand:
                _write_text(printer, f"{dbl}Brand:  {brand}{normal}\n")
            if item_group:
                _write_text(printer, f"{dbl}Dept:   {item_group}{normal}\n")
            if style_code:
                _write_text(printer, f"{dbl}Style:  {style_code}{normal}\n")
            if colour:
                _write_text(printer, f"{dbl}Colour: {colour}{normal}\n")
            if size:
                _write_text(printer, f"{dbl}Size:   {size}{normal}\n")
            qty_int = int(qty) if float(qty) == int(qty) else qty
            _write_text(printer, f"{dbl_wide}{bold_on}Qty: {qty_int}{bold_off}{normal}\n")

            if barcode:
                _write_text(printer, f"{dbl}SKU: {barcode}{normal}\n")
                safe_barcode = re.sub(r"[^A-Z0-9\-\.\$\/\+\% ]", "", barcode.upper())
                if safe_barcode:
                    _write_custom_hex(printer, _escpos_barcode_code39_hex(safe_barcode))

        _write_text(printer, f"{center}{sep}\n{left}")
        printer.write(b"\n" * 4)
        _write_cut(printer)

    try:
        _send()
    except Exception as exc:
        logging.warning("[picking-note] print failed: %s", exc)
        return jsonify(ok=False, error=str(exc)), 500

    return jsonify(ok=True)


@app.get("/health")
def health():
    return "ok", 200


if __name__ == "__main__":
    if PRINTER_NAME:
        logging.info("Starting receipt agent on http://%s:%d using Windows printer %r", HOST, PORT, PRINTER_NAME)
    else:
        logging.info("Starting receipt agent on http://%s:%d printing to %s@%d", HOST, PORT, SERIAL_PORT, BAUD_RATE)
    # Avoid Flask reloader to keep serial port exclusive
    app.run(host=HOST, port=PORT, debug=False, use_reloader=False)
