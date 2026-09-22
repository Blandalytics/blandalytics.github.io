"""Capture real PNG output from each blandalytics.com app for the homepage tiles.

Drives headless Chrome over the DevTools protocol. For apps with a Save/Download PNG
button, it clicks the button and captures the blob the app hands to its download link.
The NHL Draft Tool has no export, so it starts a mock draft and screenshots the result.
"""
import base64
import json
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9333
OUT = Path(__file__).parent / "cache"  # full-size exports; make_tiles.py crops them into images/

# Record every blob handed to URL.createObjectURL, then intercept download-link clicks
# so the PNG lands in window.__pngs as a data URL instead of the downloads folder.
HOOK = r"""
window.__blobs = {}; window.__pngs = [];
const _oco = URL.createObjectURL;
URL.createObjectURL = function (o) { const u = _oco.call(URL, o); window.__blobs[u] = o; return u; };
URL.revokeObjectURL = function () {};
const _click = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  if (this.download && this.href.startsWith('data:image/')) { window.__pngs.push(this.href); return; }
  const b = window.__blobs[this.href];
  if (this.download && b) {
    const fr = new FileReader();
    fr.onload = () => window.__pngs.push(fr.result);
    fr.readAsDataURL(b);
    return;
  }
  return _click.call(this);
};
"""

APPS = [
    # name, url, ready condition, button id
    # Jacob deGrom, 2026-09-10 (#gamePk-pitcherId)
    ("pitcher-cards", "https://blandalytics.com/pitcher-cards/#823088-594798",
     "!document.getElementById('png').hidden && document.title.includes('deGrom')", "png"),
    # Gavin Williams, 2026-09-20 (#pitcherId-date)
    ("sequencing-flow", "https://blandalytics.com/sequencing-flow/#668909-2026-09-20",
     "!document.getElementById('png').hidden && document.querySelector('.main-svg, canvas') && document.title.includes('Gavin Williams')", "png"),
    ("swing-profiles", "https://blandalytics.com/swing-profiles/",
     "document.getElementById('fig') && document.getElementById('fig').width > 0 && document.getElementById('out') && !document.getElementById('out').hidden", "dl_png"),
    ("batted-balls", "https://blandalytics.com/batted-balls/",
     "document.getElementById('fig') && document.getElementById('fig').width > 0 && document.getElementById('out') && !document.getElementById('out').hidden", "dl_png"),
    # Paul Skenes, 2026, the usage-weighted overlap
    ("release-angles", "https://blandalytics.com/release-angles/#2026-694973&view=share",
     "document.getElementById('out') && !document.getElementById('out').hidden && document.getElementById('note').textContent", "dl_png"),
]


class Tab:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=120, suppress_origin=True)
        self.n = 0

    def call(self, method, **params):
        self.n += 1
        mid = self.n
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    def eval(self, expr):
        r = self.call("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in r:
            return None
        return r["result"].get("value")

    def wait_for(self, expr, timeout, label):
        end = time.time() + timeout
        while time.time() < end:
            if self.eval(f"!!({expr})"):
                return
            time.sleep(0.5)
        raise TimeoutError(f"timed out waiting for {label}")


def new_tab():
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/json/new?about:blank", method="PUT")
    info = json.loads(urllib.request.urlopen(req).read())
    tab = Tab(info["webSocketDebuggerUrl"])
    tab.call("Page.enable")
    tab.call("Runtime.enable")
    tab.call("Emulation.setDeviceMetricsOverride", width=1280, height=1600, deviceScaleFactor=2, mobile=False)
    return tab


def grab_export(name, url, ready, button):
    tab = new_tab()
    tab.call("Page.addScriptToEvaluateOnNewDocument", source=HOOK)
    tab.call("Page.navigate", url=url)
    tab.wait_for(ready, 60, f"{name} to render")
    time.sleep(2)  # let fonts and transitions settle
    tab.eval(f"document.getElementById('{button}').click()")
    tab.wait_for("window.__pngs.length > 0", 60, f"{name} PNG export")
    data_url = tab.eval("window.__pngs[0]")
    (OUT / f"{name}.png").write_bytes(base64.b64decode(data_url.split(",", 1)[1]))
    print(f"{name}: exported {len(data_url) * 3 // 4 // 1024} KB")


def grab_nhl_draft():
    tab = new_tab()
    tab.call("Page.navigate", url="https://blandalytics.com/nhl-draft/")
    tab.wait_for("!document.getElementById('start').disabled", 180, "NHL runtime to load")
    tab.eval("document.getElementById('start').click()")
    tab.wait_for("!document.getElementById('draft').hidden && document.querySelector('#options table')", 180, "NHL options table")
    time.sleep(20)  # let the simulated finishes refine
    rect = tab.eval(
        "(() => { const r = document.getElementById('options').getBoundingClientRect();"
        " return {x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height}; })()"
    )
    shot = tab.call("Page.captureScreenshot", format="png", captureBeyondViewport=True,
                    clip={**rect, "scale": 1})
    (OUT / "nhl-draft.png").write_bytes(base64.b64decode(shot["data"]))
    print(f"nhl-draft: screenshot of #options {rect['width']:.0f}x{rect['height']:.0f}")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="bland-chrome-")
    chrome = subprocess.Popen([
        CHROME, "--headless=new", f"--remote-debugging-port={PORT}", f"--user-data-dir={profile}",
        "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "about:blank",
    ])
    try:
        for _ in range(40):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version")
                break
            except OSError:
                time.sleep(0.25)
        only = set(sys.argv[1:])
        for app in APPS:
            if not only or app[0] in only:
                try:
                    grab_export(*app)
                except Exception as e:
                    print(f"{app[0]}: FAILED {e}")
        if not only or "nhl-draft" in only:
            try:
                grab_nhl_draft()
            except Exception as e:
                print(f"nhl-draft: FAILED {e}")
    finally:
        chrome.terminate()


if __name__ == "__main__":
    main()
