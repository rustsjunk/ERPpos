"""
Manual barcode tests that start the receipt agent in-process and post
several ESC/POS variations to try printing barcodes.

Run with `py test_barcode.py` (matches your existing command); the script
starts :mod:`receipt_agent` in a background thread and then posts five
different payloads covering raw ESC/POS barcodes, a QR code, and a simple
bitmap (image) test.

Make sure your printer is available on the serial port defined by
RECEIPT_SERIAL_PORT / RECEIPT_SERIAL_BAUD before running this script.
"""

import json
import threading
import time
import http.client
import logging

from receipt_agent import app, HOST, PORT

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")


def _start_receipt_agent() -> None:
    """Launch the receipt agent HTTP server in a daemon thread."""
    thread = threading.Thread(
        target=lambda: app.run(host=HOST, port=PORT, debug=False, use_reloader=False),
        daemon=True,
        name="receipt-agent",
    )
    thread.start()
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        try:
            conn = http.client.HTTPConnection(HOST, PORT, timeout=1)
            conn.request("GET", "/health")
            resp = conn.getresponse()
            resp.close()
            if resp.status == 200:
                return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError("Receipt agent did not start in time")


def _post(payload: dict) -> tuple[int, str]:
    """POST JSON to the receipt agent and return (status, body)."""
    conn = http.client.HTTPConnection(HOST, PORT, timeout=10)
    body = json.dumps(payload).encode("utf-8")
    conn.request(
        "POST",
        "/print",
        body=body,
        headers={"Content-Type": "application/json"},
    )
    resp = conn.getresponse()
    data = resp.read().decode("utf-8")
    conn.close()
    return resp.status, data


def _hex_bytes(*chunks: bytes) -> str:
    return " ".join(chunk.hex() for chunk in chunks)


def _build_barcode_sequence(m: int, value: str) -> list[str]:
    """Return ESC/POS commands for GS k (barcode) with the provided value."""
    length = len(value)
    value_hex = " ".join(f"{ord(c):02x}" for c in value)
    return [
        "1b 40",  # initialize
        f"1d 6b {m:02x} {length:02x} {value_hex}",
        "0a",
    ]


def _build_qr_payload(data: str) -> list[str]:
    """Build the ESC/POS command sequence for a QR code."""
    chunks: list[str] = [
        "1b 40",  # initialize
        "1d 28 6b 04 00 31 41 32 00",  # select model 2
        "1d 28 6b 03 00 31 43 08",  # module size 8
        "1d 28 6b 03 00 31 45 30",  # error correction level 48
    ]
    data_bytes = data.encode("utf-8")
    length = len(data_bytes) + 3
    pL = length & 0xFF
    pH = (length >> 8) & 0xFF
    data_hex = " ".join(f"{b:02x}" for b in data_bytes)
    chunks.append(f"1d 28 6b {pL:02x} {pH:02x} 31 50 30 {data_hex}")
    chunks.append("1d 28 6b 03 00 31 51 30")  # print QR code
    return chunks


def _build_barcode_bitmap(width: int, height: int) -> bytes:
    """Create a simple bitmap that approximates a barcode pattern."""
    bars = [(3, True), (5, False), (2, True), (4, False), (6, True), (4, False)]
    pattern = []
    while len(pattern) < width:
        for chunk_width, filled in bars:
            pattern.extend([1 if filled else 0] * chunk_width)
            if len(pattern) >= width:
                break
    pattern = pattern[:width]

    width_bytes = width // 8
    header = b"\x1d\x76\x30\x00" + width_bytes.to_bytes(2, "little") + height.to_bytes(2, "little")
    data = bytearray()
    for _ in range(height):
        for byte_index in range(width_bytes):
            byte = 0
            for bit_index in range(8):
                pixel_index = byte_index * 8 + bit_index
                if pixel_index >= width:
                    continue
                bit = pattern[pixel_index]
                byte |= (bit & 1) << (7 - bit_index)
            data.append(byte)
    return header + bytes(data)


def main() -> None:
    _start_receipt_agent()
    bitmap_hex = _hex_bytes(_build_barcode_bitmap(width=64, height=48))

    tests = [
        {
            "name": "Code39 raw ESC/POS",
            "payload": {
                "text": "Test 1 - Code39 (GS k 0x45)\n",
                "hex": _build_barcode_sequence(m=0x45, value="LOCAL-BARCODE-39"),
                "line_feeds": 4,
            },
        },
        {
            "name": "Code128 raw ESC/POS",
            "payload": {
                "text": "Test 2 - Code128 (GS k 0x49)\n",
                "hex": _build_barcode_sequence(m=0x49, value="CODE128-TEST01"),
                "line_feeds": 3,
            },
        },
        {
            "name": "QR code",
            "payload": {
                "text": "Test 3 - QR code\n",
                "hex": _build_qr_payload("https://erpnext.com/demo-barcode"),
                "line_feeds": 3,
            },
        },
        {
            "name": "Bitmap barcode image",
            "payload": {
                "text": "Test 4 - Bitmap barcode (raster)\n",
                "hex": [bitmap_hex],
                "line_feeds": 3,
                "cut": False,
            },
        },
        {
            "name": "ASCII fallback",
            "payload": {
                "text": (
                    "Test 5 - ASCII fallback\n"
                    "|| ||| | |||||| ||| |||||\n"
                    "|| ||| | |||||| ||| |||||\n"
                ),
                "line_feeds": 5,
            },
        },
    ]

    results = []
    for test in tests:
        logging.info("Sending %s", test["name"])
        status, body = _post(test["payload"])
        results.append((test["name"], status, body))
        time.sleep(0.3)

    for name, status, body in results:
        logging.info("Result %s -> %s %s", name, status, body.strip())


if __name__ == "__main__":
    main()
