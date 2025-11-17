import serial, time

ser = serial.Serial("COM3", 9600, timeout=1)   # same port/baud as your agent

raw = bytes.fromhex(
    "1b 40 0a"                                  # ESC @ + LF
    " 1d 68 50"                                 # GS h 0x50
    " 1d 77 02"                                 # GS w 0x02
    " 1d 48 02"                                 # GS H 0x02
    " 1d 6b 45 17"                              # GS k 0x45, n=23 (Code39 B)
    " 4c 4f 43 41 4c 2d 32 30 32 35 31 31 31 37 2d 39 30 33 41 33 36 35 30"
    " 0a"                                       # LF after barcode
    " 49 6e 76 6f 69 63 65 3a 20"               # "Invoice: "
    " 4c 4f 43 41 4c 2d 32 30 32 35 31 31 31 37 2d 39 30 33 41 33 36 35 30"
    " 0a"                                       # LF
)

print("TEST HEX:", raw.hex(" "))
ser.write(raw)
ser.flush()
time.sleep(1)
ser.close()
