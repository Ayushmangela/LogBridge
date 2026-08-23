// LogBridge desktop shell.
//
// This app has exactly one job: remember which server URL to open, and load
// it in a window. It does not render anything itself — apps/server serves
// the same page a browser would get at "/". See DECISIONS.md D22.

const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const configPath = path.join(app.getPath("userData"), "config.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

function normalizeUrl(raw) {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    return null;
  }
}

let win;

function showConnectScreen() {
  win.loadFile(path.join(__dirname, "connect.html"));
}

function connectTo(url) {
  win.loadURL(url).catch(() => {
    // couldn't reach it — drop back to the connect screen with the bad URL
    // pre-filled so the person can see what they typed and try again.
    win.loadFile(path.join(__dirname, "connect.html"), { query: { err: "1", url } });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#0d0f18",
    title: "LogBridge",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // links to the outside world (e.g. GitHub issue links, once that exists)
  // open in the system browser, not inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const cfg = readConfig();
  if (cfg.serverUrl) connectTo(cfg.serverUrl);
  else showConnectScreen();
}

ipcMain.handle("logbridge:get-server-url", () => readConfig().serverUrl ?? null);

ipcMain.handle("logbridge:set-server-url", (_evt, raw) => {
  const url = normalizeUrl(String(raw ?? ""));
  if (!url) return { ok: false, error: "Enter a full URL, e.g. https://your-hub.tail1234.ts.net or http://localhost:8787" };
  writeConfig({ ...readConfig(), serverUrl: url });
  connectTo(url);
  return { ok: true };
});

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Change Server…",
          click: () => showConnectScreen(),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
