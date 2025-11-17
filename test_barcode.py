import serial, time

ser = serial.Serial("COM3", 19200, timeout=1)  # adjust baudrate if needed

raw = bytes.fromhex(
    "1b 40 0a"
    " 1d 68 50"
    " 1d 77 02"
    " 1d 48 02"
    " 1d 6b 45 17"
    " 4c 4f 43 41 4c 2d 32 30 32 35 31 31 31 37 2d 39 30 33 41 33 36 35 30"
    " 0a"
    " 49 6e 76 6f 69 63 65 3a 20"
    " 4c 4f 43 41 4c 2d 32 30 32 35 31 31 31 37 2d 39 30 33 41 33 36 35 30"
    " 0a"
)

print("TEST HEX:", raw.hex(" "))
ser.write(raw)
ser.flush()
time.sleep(1)
ser.close()
