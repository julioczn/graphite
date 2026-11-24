// Main process: windows, native dialogs, secrets and the utility process.
// utilityProcess that talks to the renderer directly over a MessagePort.
const path = require("node:path");
const fs = require("node:fs/promises");
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  utilityProcess,
  MessageChannelMain,
  nativeTheme,
  safeStorage,
  shell,
  Menu,
} = require("electron");
const { AiHub } = require("./ai/hub.cjs");
const { McpHost } = require("./ai/mcp.cjs");
const { Assistant } = require("./ai/assistant.cjs");
const i18n = require("../shared/i18n.mjs");
const { t } = i18n;

const isDev = !!process.env.VITE_DEV_SERVER_URL;
// Separate profile (settings, saved connections, demo) for tests and
// development, so they never touch the installed app's data.
if (process.env.GRAPHITE_PROFILE_DIR) app.setPath("userData", process.env.GRAPHITE_PROFILE_DIR);
let util = null;
let ai = null; // { hub, mcp, assistant }, created when the app is ready

// --- interface language -------------------------------------------------------
// The preference ('system' or a locale id) lives in userData/prefs.json; main,
// the utility process and every window follow the resolved locale.
const prefsFile = () => path.join(app.getPath("userData"), "prefs.json");
let prefs = { locale: "system" };
function loadPrefs() {
  try {
    prefs = { ...prefs, ...JSON.parse(require("node:fs").readFileSync(prefsFile(), "utf8")) };
  } catch {}
  applyLocale();
}
function applyLocale() {
  i18n.setLocale(i18n.resolveLocale(prefs.locale, app.getPreferredSystemLanguages()));
}
const localeInfo = () => ({ pref: prefs.locale, locale: i18n.getLocale() });
ipcMain.handle("app:locale", () => localeInfo());
ipcMain.handle("app:setLocale", async (_e, pref) => {
  if (pref !== "system" && !i18n.LOCALES.some((l) => l.id === pref)) throw new Error("unknown locale");
  prefs.locale = pref;
  applyLocale();
  await fs.writeFile(prefsFile(), JSON.stringify(prefs, null, 2));
  util?.postMessage({ type: "locale", locale: i18n.getLocale() });
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("app:locale", localeInfo());
  return localeInfo();
});

function startUtility() {
  if (util) return util;
  util = utilityProcess.fork(path.join(__dirname, "utility.cjs"), [], {
    serviceName: "GraphiteUtility",
    stdio: "inherit",
    env: { ...process.env, GRAPHITE_USER_DATA: app.getPath("userData"), GRAPHITE_LOCALE: i18n.getLocale() },
  });
  // The AI hub and GitHub sync talk to the utility over ports of their own.
  ai?.hub.attachUtil(util);
  syncUtil?.attach(util);
  util.on("exit", (code) => {
    util = null;
    ai?.hub.detachUtil();
    syncUtil?.detach();
    if (code) {
      console.error("[main] utility process died, restarting", code);
      startUtility();
      for (const w of BrowserWindow.getAllWindows()) {
        connectPorts(w);
        w.webContents.send("util-restarted");
      }
    }
  });
  return util;
}

// Give the renderer and the utility process each one end of a channel.
function connectPorts(win) {
  const { port1, port2 } = new MessageChannelMain();
  startUtility().postMessage({ type: "port", windowId: win.id }, [port1]);
  win.webContents.postMessage("port", null, [port2]);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#0a0a0a",
    title: "Graphite",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.on("did-finish-load", () => connectPorts(win));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

// --- IPC: things only the main process can do -----------------------------

ipcMain.handle("dialog:openFile", async (e, opts = {}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  // opts.sshKey: start in ~/.ssh (hidden files shown) and answer with a ~/… path,
  // which stays valid on the user's other machines when the workspace syncs.
  const home = require("node:os").homedir();
  const res = await dialog.showOpenDialog(win, {
    properties: ["openFile", ...(opts.create ? ["promptToCreate"] : []), ...(opts.sshKey ? ["showHiddenFiles"] : [])],
    filters: opts.filters,
    ...(opts.sshKey && { defaultPath: path.join(home, ".ssh") }),
  });
  if (res.canceled) return null;
  const file = res.filePaths[0];
  if (opts.sshKey && file.startsWith(home + path.sep)) return "~/" + path.relative(home, file).split(path.sep).join("/");
  return file;
});

ipcMain.handle(
  "dialog:saveFile",
  async (e, { defaultName, content, filters, encoding = "utf8" }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath("downloads"), defaultName),
      filters,
    });
    if (res.canceled || !res.filePath) return null;
    await fs.writeFile(
      res.filePath,
      encoding === "base64" ? Buffer.from(content, "base64") : content,
      encoding === "base64" ? undefined : "utf8",
    );
    return res.filePath;
  },
);

// Only picks a path; the utility process writes / reads the file itself
// (backups and exports can be far bigger than an IPC message).
ipcMain.handle(
  "dialog:choosePath",
  async (e, { mode = "save", defaultName = "", filters, title } = {}) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (mode === "save") {
      const res = await dialog.showSaveDialog(win, {
        title,
        defaultPath: path.join(app.getPath("downloads"), defaultName),
        filters,
      });
      return res.canceled ? null : res.filePath || null;
    }
    const res = await dialog.showOpenDialog(win, {
      title,
      defaultPath:
        mode === "folder"
          ? path.join(app.getPath("downloads"), defaultName)
          : app.getPath("downloads"),
      properties:
        mode === "folder"
          ? ["openDirectory", "createDirectory", "promptToCreate"]
          : ["openFile"],
      filters: mode === "folder" ? undefined : filters,
    });
    return res.canceled ? null : res.filePaths[0];
  },
);

ipcMain.handle("shell:showItem", (_e, file) => shell.showItemInFolder(file));

// Passwords never hit disk in plain text when the OS keyring is available.
function encryptSecret(plain) {
  if (!plain) return "";
  if (safeStorage.isEncryptionAvailable()) {
    return "enc:" + safeStorage.encryptString(plain).toString("base64");
  }
  return "b64:" + Buffer.from(plain, "utf8").toString("base64");
}
ipcMain.handle("secret:encrypt", (_e, plain) => encryptSecret(plain));

ipcMain.handle("secret:decrypt", (_e, stored) => {
  if (!stored) return "";
  if (stored.startsWith("enc:")) {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
  }
  if (stored.startsWith("b64:"))
    return Buffer.from(stored.slice(4), "base64").toString("utf8");
  return stored;
});

// --- AI: assistant, MCP server, approvals -------------------------------------

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

// A write from an agent needs a window to approve it in: bring one up.
function windowForApproval() {
  let win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (!win) {
    createWindow();
    return; // it loads the pending approvals itself (ai:pending)
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (process.platform === "darwin") app.dock?.bounce("critical");
  else win.flashFrame(true);
}

function aiState() {
  return { settings: ai.hub.publicSettings(), mcp: ai.mcp.status() };
}

async function applyMcp() {
  const { enabled, port, token } = ai.hub.data.mcp;
  if (enabled) await ai.mcp.start({ port, token });
  else await ai.mcp.stop();
}

function setupAi() {
  const hub = new AiHub({ userData: app.getPath("userData"), safeStorage });
  ai = { hub, mcp: new McpHost(hub, app.getVersion()), assistant: new Assistant(hub) };
  if (util) hub.attachUtil(util);
  hub.on("approval", (req) => {
    broadcast("ai:approval", req);
    windowForApproval();
  });
  hub.on("approvalDone", (d) => broadcast("ai:approvalDone", d));
  hub.on("activity", (e) => broadcast("ai:activity", e));
  hub.on("mcp", (st) => broadcast("ai:mcp", st));

  ipcMain.handle("ai:state", () => aiState());
  ipcMain.handle("ai:update", async (_e, patch) => {
    const before = { ...hub.data.mcp };
    hub.update(patch);
    const m = hub.data.mcp;
    if (m.enabled !== before.enabled || m.port !== before.port || m.token !== before.token) await applyMcp();
    return aiState();
  });
  ipcMain.handle("ai:setActive", (_e, info) => hub.setActive(info));
  ipcMain.handle("ai:decide", (_e, { id, ok }) => hub.decide(id, ok, ok ? null : t("recusado pelo usuário")));
  ipcMain.handle("ai:pending", () => hub.pendingApprovals());
  ipcMain.handle("ai:activity", () => hub.activity);
  ipcMain.handle("ai:test", () => ai.assistant.test());
  ipcMain.handle("ai:models", (_e, q = {}) =>
    ai.assistant.models({
      provider: q.provider === "openai" ? "openai" : "anthropic",
      baseUrl: typeof q.baseUrl === "string" ? q.baseUrl.trim() : "",
      apiKey: typeof q.apiKey === "string" ? q.apiKey.trim() : "",
    }),
  );
  ipcMain.handle("ai:chatSend", (e, { convId, text, context }) => {
    const sender = e.sender;
    return ai.assistant.send(convId, { text, context }, (ev) => {
      if (!sender.isDestroyed()) sender.send("ai:chat", { convId, ...ev });
    });
  });
  ipcMain.handle("ai:chatStop", (_e, { convId }) => ai.assistant.stop(convId));
  ipcMain.handle("ai:chatReset", (_e, { convId }) => ai.assistant.reset(convId));

  applyMcp().catch((e) => console.error("[main] MCP server", e));
}

// --- updates -------------------------------------------------------------------
let updater = null;
function setupUpdater() {
  const { Updater } = require("./updater.cjs");
  updater = new Updater({
    getPref: (k) => prefs[k],
    setPref: (k, v) => {
      prefs[k] = v;
      require("node:fs").writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2));
    },
  });
  updater.on("state", (s) => broadcast("update:state", s));
  updater.start();
}
ipcMain.handle("update:state", () => updater.publicState());
ipcMain.handle("update:check", () => updater.check());
ipcMain.handle("update:download", () => updater.download());
ipcMain.handle("update:install", () => updater.installAndRestart());
ipcMain.handle("update:setAuto", (_e, on) => updater.setAuto(on));
ipcMain.handle("update:openPage", () => updater.openReleasePage());

// --- workspaces: export / import files, GitHub sync -----------------------------
let sync = null;
let syncUtil = null;
function setupSync() {
  const { GitHubSync } = require("./github-sync.cjs");
  const { UtilBridge } = require("./ai/hub.cjs");
  syncUtil = new UtilBridge();
  if (util) syncUtil.attach(util);
  sync = new GitHubSync({ userData: app.getPath("userData"), safeStorage, util: syncUtil, openExternal: (u) => shell.openExternal(u) });
  sync.on("state", (s) => broadcast("ws:github", s));
  sync.on("error", (msg) => broadcast("ws:githubError", msg));
  sync.on("changed", (d) => broadcast("ws:changed", d));
  sync.on("syncing", (d) => broadcast("ws:syncing", d));
  sync.on("remote", (list) => broadcast("ws:remote", list));
  sync.start();
}
const W = require("./lib/workspace.cjs");
ipcMain.handle("ws:export", async (e, { id, format }) => {
  const doc = await syncUtil.call("app/workspaceDoc", { id });
  const ext = format === "json" ? "json" : "yml";
  const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    defaultPath: path.join(app.getPath("downloads"), `${W.slug(doc.name)}.graphite.${ext}`),
    filters: [{ name: format === "json" ? "JSON" : "YAML", extensions: [ext] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, W.serialize(doc, format), "utf8");
  return res.filePath;
});
ipcMain.handle("ws:import", async (e) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    properties: ["openFile"],
    filters: [{ name: t("Workspace do Graphite"), extensions: ["yml", "yaml", "json"] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const doc = W.parseFile(await fs.readFile(res.filePaths[0], "utf8"));
  return syncUtil.call("app/importWorkspace", { doc });
});
// Connections from other tools (DBeaver, DataGrip, Beekeeper…): electron/importers.
const importers = require("./importers/index.cjs");
ipcMain.handle("imp:detect", () => importers.detect());
ipcMain.handle("imp:file", async (e) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    properties: ["openFile", "showHiddenFiles"],
    title: t("Arquivo de conexões de outra ferramenta"),
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return importers.readFile(res.filePaths[0]);
});
ipcMain.handle("imp:apply", async (_e, { token, picks, withPasswords, withQueries, workspaceId, newName }) => {
  const r = importers.take(token, { picks, withPasswords, withQueries });
  const out = await syncUtil.call("app/importConnections", {
    workspaceId,
    newName: newName || r.label,
    connections: r.connections.map(({ sshSecret, ...c }) => ({
      ...c,
      password: c.password ? encryptSecret(c.password) : null,
      // The tunnel's password / key passphrase, encrypted inside config.ssh.
      ...(sshSecret && c.config?.ssh && { config: { ...c.config, ssh: { ...c.config.ssh, secretEnc: encryptSecret(sshSecret) } } }),
    })),
    queries: r.queries,
  });
  sync.touch(out.workspaceId);
  return out;
});
ipcMain.handle("ws:github", () => sync.state());
ipcMain.handle("ws:githubLogin", () => sync.startDeviceLogin());
ipcMain.handle("ws:githubCancel", () => sync.cancelDeviceLogin());
ipcMain.handle("ws:githubToken", (_e, token) => sync.setToken(token));
ipcMain.handle("ws:githubLogout", () => sync.logout());
ipcMain.handle("ws:githubRepos", () => sync.repos());
ipcMain.handle("ws:remoteList", (_e, repo) => (repo ? sync.remoteWorkspaces({ repo }) : sync.remote));
ipcMain.handle("ws:remoteScan", () => sync.remoteWorkspaces());
ipcMain.handle("ws:openRemote", (_e, { repo, dir }) => sync.openRemote({ repo, dir }));
ipcMain.handle("ws:link", (_e, { id, repo, dir }) => sync.link(id, { repo, dir }));
ipcMain.handle("ws:unlink", (_e, id) => sync.unlink(id));
ipcMain.handle("ws:sync", (_e, id) => sync.sync(id));
ipcMain.handle("ws:setAuto", (_e, { id, on }) => sync.setAuto(id, on));
ipcMain.handle("ws:touched", (_e, id) => sync.touch(id));
ipcMain.handle("ws:open", (_e, url) => {
  if (/^https:\/\/github\.com\//.test(url) || url.startsWith(process.env.GRAPHITE_GITHUB_WEB || "\0")) shell.openExternal(url);
});

ipcMain.handle("app:info", () => ({
  version: app.getVersion(),
  platform: process.platform,
  userData: app.getPath("userData"),
}));

// --- lifecycle ---------------------------------------------------------------

app.whenReady().then(() => {
  nativeTheme.themeSource = "dark";
  loadPrefs();
  if (process.platform === "darwin") {
    // macOS needs an app menu: without it Cmd+C/V/X/A/Z and Cmd+Q stop working.
    // No Window/File menu on purpose, so Cmd+W / Cmd+T reach the renderer (tabs).
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "appMenu" },
        { role: "editMenu" },
        ...(isDev ? [{ role: "viewMenu" }] : []),
      ]),
    );
  } else if (!isDev) {
    Menu.setApplicationMenu(null);
  }
  setupAi();
  setupUpdater();
  setupSync();
  startUtility();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // On macOS the app stays open; keep the databases reachable while the MCP
  // server is on (agents may still be using them).
  if (util && !(process.platform === "darwin" && ai?.mcp.status().running)) util.kill();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  ai?.mcp.stop().catch(() => {});
});
