@echo off
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
set PROFILE=C:\ChromePOS
set URL=http://localhost:5000   rem <-- your POS URL

%CHROME% --user-data-dir="%PROFILE%" --app=%URL% --kiosk-printing --disable-features=TranslateUI
