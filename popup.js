// Popup: reflects chrome.storage.sync, saves on change.
// bindSettingsForm comes from settings.js.

bindSettingsForm(document);

async function checkGrabStatus() {
  const el = document.getElementById("grabStatus");
  // GET the root: Grab's router 404s (no route there), but any HTTP response
  // means it's listening. We avoid POSTing to /add because even an empty URL
  // would trigger Grab's "Invalid URL" toast.
  // 3s timeout: a port that accepts but never answers shouldn't hang the UI.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    await fetch("http://127.0.0.1:9412/", { method: "GET", signal: ctrl.signal });
    el.textContent = "Grab is running";
    el.className = "status ok";
  } catch {
    el.textContent = "Grab isn't running — downloads will stay in the browser";
    el.className = "status down";
  } finally {
    clearTimeout(timer);
  }
}

document.getElementById("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

checkGrabStatus();
