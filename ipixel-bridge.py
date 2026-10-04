#!/usr/bin/env python3
"""Local BLE bridge for iPixel Color Studio.

Use it where the browser has no working Web Bluetooth (for example Chrome on
Linux). It scans and connects with bleak exactly like iPixel-CLI / pypixelcolor
(name contains "LED", write fa02 with response, notify fa03), serves this folder
over http://localhost and relays raw bytes to the page over a WebSocket.

    pip install bleak "websockets>=13"
    python3 ipixel-bridge.py            # then open http://localhost:8765/

WebSocket protocol (JSON text frames, path /ble):
    -> {"op": "scan", "timeout": 10, "all": false}
    <- {"op": "scan", "devices": [{"address", "name", "rssi"}]}
    -> {"op": "connect", "address": "AA:BB:..."}
    <- {"op": "connected", "address", "name"}
    -> {"op": "write", "id": 1, "hex": "0500..."}
    <- {"op": "written", "id": 1}
    <- {"op": "notify", "hex": "0500010003"}
    -> {"op": "disconnect"}
    <- {"op": "disconnected"}
    <- {"op": "error", "id"?, "message"}
"""

import argparse
import asyncio
import json
import logging
import mimetypes
from http import HTTPStatus
from pathlib import Path

from bleak import BleakClient, BleakScanner
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

WRITE_UUID = "0000fa02-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000fa03-0000-1000-8000-00805f9b34fb"
ROOT = Path(__file__).resolve().parent

log = logging.getLogger("ipixel-bridge")


async def scan(timeout: float, show_all: bool, settle: float = 2.0) -> list[dict]:
    """Same filter as pypixelcolor.scanner.scan_devices: name contains "LED".

    Panels advertise slowly right after a disconnect, so scan for up to `timeout`
    seconds but stop `settle` seconds after the first match.
    """
    seen: dict[str, dict] = {}
    first = asyncio.Event()

    def on_adv(d, adv):
        name = d.name or adv.local_name or ""
        if show_all or "LED" in name:
            seen[d.address] = {"address": d.address, "name": name, "rssi": adv.rssi}
            first.set()

    async with BleakScanner(detection_callback=on_adv):
        try:
            await asyncio.wait_for(first.wait(), timeout)
            await asyncio.sleep(settle)
        except asyncio.TimeoutError:
            pass
    return sorted(seen.values(), key=lambda d: -d["rssi"])


class Session:
    """One BLE connection, owned by one WebSocket client."""

    def __init__(self, ws):
        self.ws = ws
        self.client: BleakClient | None = None

    async def send(self, **msg):
        try:
            await self.ws.send(json.dumps(msg))
        except Exception:
            pass

    def _on_disconnect(self, client):
        if client is not self.client:  # replaced or closed on purpose
            return
        log.info("BLE device disconnected")
        self.client = None
        asyncio.get_running_loop().create_task(self.send(op="disconnected"))

    async def connect(self, address: str):
        await self.disconnect(notify=False)
        log.info("Connecting to %s…", address)
        client = BleakClient(address, disconnected_callback=self._on_disconnect, timeout=20)
        await client.connect()
        try:
            await client.start_notify(NOTIFY_UUID, lambda _, data: asyncio.ensure_future(self.send(op="notify", hex=bytes(data).hex())))
        except Exception as e:
            log.warning("Failed to enable notifications on %s: %s", NOTIFY_UUID, e)
        self.client = client
        name = getattr(client, "name", None) or address
        log.info("Connected to %s", name)
        return name

    async def write(self, data: bytes):
        if not self.client or not self.client.is_connected:
            raise RuntimeError("not connected")
        await self.client.write_gatt_char(WRITE_UUID, data, response=True)

    async def disconnect(self, notify=True):
        client, self.client = self.client, None
        if client and client.is_connected:
            try:
                await client.stop_notify(NOTIFY_UUID)
            except Exception:
                pass
            await client.disconnect()
        if notify:
            await self.send(op="disconnected")


async def handle(ws):
    session = Session(ws)
    log.info("Page connected")
    try:
        async for raw in ws:
            msg, mid = {}, None
            try:
                msg = json.loads(raw)
                op, mid = msg.get("op"), msg.get("id")
                if op == "write":
                    await session.write(bytes.fromhex(msg["hex"]))
                    await session.send(op="written", id=mid)
                elif op == "scan":
                    devices = await scan(float(msg.get("timeout", 10)), bool(msg.get("all")))
                    await session.send(op="scan", id=mid, devices=devices)
                elif op == "connect":
                    name = await session.connect(msg["address"])
                    await session.send(op="connected", id=mid, address=msg["address"], name=name)
                elif op == "disconnect":
                    await session.disconnect()
                elif op == "hello":
                    await session.send(op="hello", id=mid, version=1)
                else:
                    raise ValueError(f"unknown op {op!r}")
            except Exception as e:
                log.warning("%s failed: %s", msg.get("op", "message"), e)
                await session.send(op="error", id=mid, message=str(e) or type(e).__name__)
    finally:
        log.info("Page disconnected")
        await session.disconnect(notify=False)


def static_files(connection, request):
    """Serve this folder so the page and the bridge share the localhost origin."""
    path = request.path.split("?", 1)[0]
    if path == "/ble":
        return None  # WebSocket upgrade
    rel = path.lstrip("/") or "index.html"
    file = (ROOT / rel).resolve()
    if ROOT not in file.parents or not file.is_file() or file.name.startswith("."):
        return connection.respond(HTTPStatus.NOT_FOUND, "Not found\n")
    ctype = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
    if file.suffix == ".webmanifest":
        ctype = "application/manifest+json"
    body = file.read_bytes()
    headers = Headers({"Content-Type": ctype, "Content-Length": str(len(body)), "Cache-Control": "no-cache"})
    return Response(HTTPStatus.OK.value, HTTPStatus.OK.phrase, headers, body)


async def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--host", default="localhost", help="bind address (default: localhost)")
    ap.add_argument("-p", "--port", type=int, default=8765, help="port (default: 8765)")
    ap.add_argument("-s", "--scan", action="store_true", help="scan for panels and exit")
    ap.add_argument("--loglevel", default="INFO")
    args = ap.parse_args()
    logging.basicConfig(level=args.loglevel.upper(), format="%(asctime)s %(levelname)s %(message)s")
    # Static files show up as "rejected" upgrades and Chrome's idle preconnects as failed handshakes.
    logging.getLogger("websockets").setLevel(logging.CRITICAL)

    if args.scan:
        for d in await scan(10.0, False):
            print(f"{d['address']}  {d['name']}  RSSI {d['rssi']}")
        return

    async with serve(handle, args.host, args.port, process_request=static_files, max_size=2**22) as server:
        log.info("Open http://localhost:%d/ in Chrome (bridge at ws://localhost:%d/ble)", args.port, args.port)
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
