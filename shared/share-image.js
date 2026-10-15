/* Share image: the one export button of every blandalytics.com tool. A click opens a menu of
   Copy image and Download PNG (and any other downloads the tool offers, such as a GIF).

     ShareImage.attach(button, [
       {heading: "Series Win%"},                                  // a group title (optional)
       {copy: () => blobOrPromise, name: () => "file.png"},       // Copy image
       {download: () => blobOrPromise, name: () => "file.png"},   // Download PNG
       {label: "Download GIF", run: () => promise of a status},   // anything else
     ]);
     ShareImage.image(button, () => blobOrPromise, () => "file.png");   // Copy image + Download PNG

   The button keeps its own id, classes and its hidden / disabled state (the tool sets those);
   its text becomes "Share image ▾" and goes back to it after a status ("Copied", "Downloaded").
   The menu items get ids for scripts: <button id>_copy, <button id>_download, or an item's own id.

   Copy image makes the ClipboardItem inside the click itself, around the promise of the image,
   so the copy keeps the click's permission while the image is drawn (Safari insists on it).
   Where the clipboard is refused (an older Firefox, an embedded view), the PNG downloads.
   Load it with <script src="/shared/share-image.js?v=N"> before the tool's own script; bump N
   with each change, because Cloudflare and browsers keep scripts for 4 hours. */
(function () {
  "use strict";
  const LABEL = "Share image ▾";
  const CSS = `
.share-menu{position:fixed; z-index:2147483000; min-width:170px; display:flex; flex-direction:column; gap:1px;
  background:#1b222c; border:1px solid #2c3541; border-radius:8px; padding:4px; box-shadow:0 10px 28px rgba(0,0,0,.5);
  font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:14px; line-height:1.3; text-align:left}
.share-menu[hidden]{display:none}
.share-menu button{all:unset; box-sizing:border-box; display:block; padding:8px 11px; border-radius:4px; cursor:pointer;
  color:#e3e9f1; white-space:nowrap; font:inherit}
.share-menu button:hover,.share-menu button:focus-visible{background:#151b23; color:#6cb4ff}
.share-menu .share-head{padding:7px 11px 2px; font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:#8a96a6}
.share-menu .share-head:not(:first-child){margin-top:4px; border-top:1px solid #2c3541; padding-top:9px}`;
  let styled = false, open = null;

  function style() {
    if (styled) return;
    const s = document.createElement("style");
    s.textContent = CSS;
    document.head.appendChild(s);
    styled = true;
  }

  function save(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  // the click's handler for a copy: returns the status to show
  async function copy(item) {
    const blob = Promise.resolve().then(item.copy);
    blob.catch(() => {}); // a failure is reported below, once
    try {
      if (!navigator.clipboard || !navigator.clipboard.write || typeof ClipboardItem === "undefined") {
        throw new Error("no image clipboard");
      }
      await navigator.clipboard.write([new ClipboardItem({"image/png": blob})]);
      return "Copied";
    } catch (e) {
      console.warn("copy failed, downloading instead:", e);
      save(await blob, item.name());
      return "Downloaded (no clipboard here)";
    }
  }

  function close() {
    if (!open) return;
    open.menu.hidden = true;
    open.button.setAttribute("aria-expanded", "false");
    open = null;
  }

  function place(button, menu) {
    // under the button, lined up with its edge on the side of the screen it is on
    const r = button.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
    let left = r.left + r.width / 2 > innerWidth / 2 ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + h > innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function attach(button, items) {
    style();
    const label = LABEL;
    button.textContent = label;
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    const menu = document.createElement("div");
    menu.className = "share-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    if (button.id) {
      menu.id = `${button.id}_menu`;
      button.setAttribute("aria-controls", menu.id);
    }
    const seen = {};
    for (const item of items) {
      if (item.heading) {
        const h = document.createElement("div");
        h.className = "share-head";
        h.textContent = item.heading;
        menu.appendChild(h);
        continue;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.textContent = item.label || (item.copy ? "Copy image" : item.download ? "Download PNG" : "Download");
      const kind = item.copy ? "copy" : item.download ? "download" : "run";
      seen[kind] = (seen[kind] || 0) + 1;  // a second copy item is <id>_copy2, and so on
      const id = item.id || (button.id ? `${button.id}_${kind}${seen[kind] > 1 ? seen[kind] : ""}` : "");
      if (id) b.id = id;
      b.addEventListener("click", async () => {
        let status = "";
        let job;
        if (kind === "copy") {
          job = copy(item); // started inside the click, before anything else
        } else if (kind === "download") {
          job = Promise.resolve().then(item.download).then(blob => { save(blob, item.name()); return "Downloaded"; });
        } else {
          job = Promise.resolve().then(item.run);
        }
        close();
        button.disabled = true;
        try {
          status = (await job) || "Done";
        } catch (e) {
          console.error(e);
          status = "Could not make the image";
        } finally {
          button.disabled = false;
          button.textContent = status;
          clearTimeout(button._shareTimer);
          button._shareTimer = setTimeout(() => { button.textContent = label; }, 1600);
        }
      });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    button.addEventListener("click", e => {
      e.stopPropagation();
      if (open && open.menu === menu) return close();
      close();
      menu.hidden = false;
      button.setAttribute("aria-expanded", "true");
      open = {button, menu};
      place(button, menu);
      const first = menu.querySelector("button");
      if (first) first.focus({preventScroll: true});
    });
    menu.addEventListener("keydown", e => {
      const bs = [...menu.querySelectorAll("button")], i = bs.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        bs[(i + (e.key === "ArrowDown" ? 1 : bs.length - 1)) % bs.length].focus();
      } else if (e.key === "Tab") {
        close();
      }
    });
    return menu;
  }

  document.addEventListener("click", e => {
    if (open && !open.menu.contains(e.target) && e.target !== open.button) close();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && open) {
      const b = open.button;
      close();
      b.focus();
    }
  });
  addEventListener("resize", close);
  addEventListener("scroll", e => { if (open && !open.menu.contains(e.target)) close(); }, true);

  window.ShareImage = {
    attach,
    image: (button, blob, name) => attach(button, [{copy: blob, name}, {download: blob, name}]),
    save,
  };
})();
