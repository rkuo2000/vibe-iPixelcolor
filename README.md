# iPixel Color 96×16 Studio (PWA)

Web Bluetooth controller for iPixel Color LED panels (96×16), ported from
[pypixelcolor](https://github.com/lucagoc/pypixelcolor). Open `iPixelcolor.html` over HTTPS (e.g. GitHub Pages) or `localhost`
in Chrome/Edge (desktop or Android), or Bluefy on iPhone/iPad, then press **Connect panel**.

## Linux: local BLE bridge

Chrome on Linux ships without Web Bluetooth (`navigator.bluetooth` is undefined), so the page can't scan.
`ipixel-bridge.py` does the Bluetooth side with [bleak](https://github.com/hbldh/bleak), the same way
[iPixel-CLI](https://github.com/SuperIlu/iPixel-CLI) does (name contains `LED`, write `fa02` with response, notify `fa03`):

```sh
pip install bleak "websockets>=13"
python3 ipixel-bridge.py          # serves this folder + ws://localhost:8765/ble
python3 ipixel-bridge.py --scan   # just list panels
```

Open <http://localhost:8765/> and press **Connect panel**. *Connect through* (Device → Connection settings) is set to
**Auto** by default: it uses the bridge when the page comes from the bridge or the browser has no Web Bluetooth.
You can force **Local bridge** or **Web Bluetooth** there. The last panel is remembered, so reconnecting skips the scan.

| Feature | pypixelcolor command |
|---|---|
| Text with inline colors `[#ff0000]…[/]`, emoji, CJK (GNU Unifont), 6 animations, rainbow, speed, background, save slot | `send_text` |
| Draw on the 96×16 canvas (pen, fill, picker, shift, mirror, undo); live pixel streaming | `send_image`, `set_fun_mode`, `set_pixel` |
| Images and animated GIFs, resized to 96×16 (crop / fit / stretch) | `send_image` |
| Clock styles 0–8, 12/24 h, date; time sync | `set_clock_mode`, `set_time` |
| Scoreboard and stopwatch | `set_scores`, `set_timer` |
| 11-band equalizer, with optional live microphone | `set_rhythm_mode`, `set_rhythm_mode_2` |
| Show and delete slots, on/off schedule | `show_slot`, `delete`, `set_schedule` |
| Power, brightness, orientation, erase memory, raw hex | `set_power`, `set_brightness`, `set_orientation`, `clear` |

Files: `iPixelcolor.html` (app), `ipixel-protocol.js` (byte encoders, checked against pypixelcolor output), `ipixel-bridge.py` (Linux BLE bridge),
`ipixelcolor-sw.js` + `ipixelcolor.webmanifest` (offline install), `fonts/unifont.woff2` (SIL OFL 1.1), `icons/`.
Bump `CACHE_NAME` in the service worker when you change cached assets.
