// Workspaces ↔ the user's own GitHub repository.
//
// Sign-in: GitHub App device flow ("Sign in with GitHub": the user confirms a
// code on github.com; the app only reaches the repositories it's installed
// on), or a fine-grained personal access token. The token is kept encrypted
// with the OS keychain (safeStorage) in userData/github.json and never leaves
// the main process.
//
// Sync, per workspace linked to { repo, branch, dir }:
//   1. read <dir>/workspace.yml and <dir>/queries/*.sql at the branch head;
//   2. three-way merge with the local workspace, against the snapshot of the
//      last sync (userData/workspace-sync/<uid>.json) — edits on both sides
//      keep both copies;
//   3. apply the result locally, then commit the changed files in one commit
//      (Git Data API) and move the branch; a race retries once.
// Workspaces already in those repositories (pushed from another machine) are
// listed by remoteWorkspaces() and brought over with openRemote().
// Only private repositories are accepted: a workspace holds host names and
// user names (never passwords).
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const W = require("./lib/workspace.cjs");
const { t } = require("../shared/i18n.mjs");

// The public GitHub App "Graphite Sync" (github.com/apps/graphite-sync): its
// client id (public, used for the device flow; there is no client secret) and
// URL name. The env vars point tests at another app.
const GITHUB_APP = {
  clientId: process.env.GRAPHITE_GITHUB_CLIENT_ID ?? "Iv23liR1iBpjE7BN7kNL",
  slug: process.env.GRAPHITE_GITHUB_APP ?? "graphite-sync",
};
const API = () => (process.env.GRAPHITE_GITHUB_API || "https://api.github.com").replace(/\/+$/, "");
const WEB = () => (process.env.GRAPHITE_GITHUB_WEB || "https://github.com").replace(/\/+$/, "");

const AUTO_EVERY = 10 * 60 * 1000;
const AUTO_AFTER_EDIT = 20 * 1000;

const gitBlobSha = (text) => {
  const buf = Buffer.from(text, "utf8");
  return crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
};
// Files sync owns inside a workspace folder; anything else there is left alone.
const OURS = /^(workspace\.yml|queries\/[^/]+\.sql)$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class GitHubSync extends EventEmitter {
  constructor({ userData, safeStorage, util, openExternal }) {
    super();
    this.file = path.join(userData, "github.json");
    this.baseDir = path.join(userData, "workspace-sync");
    this.safeStorage = safeStorage;
    this.util = util;
    this.openExternal = openExternal;
    this.auth = this.loadAuth();
    this.login = null; // device flow in progress: { userCode, uri, expiresAt }
    this.locks = new Map();
    this.timers = new Map();
    this.remote = []; // last remoteWorkspaces() result
  }

  // --- auth ----------------------------------------------------------------------

  loadAuth() {
    try {
      const a = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!a.token?.startsWith("enc:") || !this.safeStorage.isEncryptionAvailable()) return null;
      return { ...a, token: this.safeStorage.decryptString(Buffer.from(a.token.slice(4), "base64")) };
    } catch {
      return null;
    }
  }

  saveAuth(auth) {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error(t("O sistema não oferece armazenamento seguro, então não dá para guardar o acesso ao GitHub."));
    const stored = { ...auth, token: "enc:" + this.safeStorage.encryptString(auth.token).toString("base64") };
    fs.writeFileSync(this.file, JSON.stringify(stored, null, 2), { mode: 0o600 });
    this.auth = auth;
    this.emitState();
    this.remoteWorkspaces().catch(() => {});
  }

  logout() {
    this.auth = null;
    this.remote = [];
    this.emit("remote", []);
    try {
      fs.unlinkSync(this.file);
    } catch {}
    this.emitState();
  }

  state() {
    return {
      login: this.auth?.login || null,
      method: this.auth?.method || null,
      deviceFlow: !!GITHUB_APP.clientId,
      installUrl: GITHUB_APP.slug ? `${WEB()}/apps/${GITHUB_APP.slug}/installations/new` : null,
      pending: this.login && { userCode: this.login.userCode, uri: this.login.uri },
    };
  }

  emitState() {
    this.emit("state", this.state());
  }

  async request(method, url, { token = this.auth?.token, body, form } = {}) {
    const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Graphite" };
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers.Accept = "application/json";
      payload = new URLSearchParams(form).toString();
    } else if (body) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new Error(t("Sem conexão com o GitHub: {error}", { error: e.cause?.code || e.message }));
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.status === 401 && token && token === this.auth?.token) {
      this.logout();
      throw new Error(t("O acesso ao GitHub expirou ou foi revogado. Entre de novo."));
    }
    if (!res.ok) throw Object.assign(new Error(data?.message || `GitHub ${res.status}`), { status: res.status });
    return data;
  }

  api(method, p, opts) {
    if (!this.auth && !opts?.token) return Promise.reject(new Error(t("Entre no GitHub primeiro.")));
    return this.request(method, API() + p, opts);
  }

  // Device flow: shows a code, opens github.com/login/device, polls for the token.
  async startDeviceLogin() {
    if (!GITHUB_APP.clientId) throw new Error(t("O login pelo GitHub ainda não está disponível nesta versão; use um token pessoal."));
    this.cancelDeviceLogin();
    const r = await this.request("POST", `${WEB()}/login/device/code`, { token: null, form: { client_id: GITHUB_APP.clientId } });
    const flow = { userCode: r.user_code, uri: r.verification_uri, expiresAt: Date.now() + r.expires_in * 1000, cancelled: false };
    this.login = flow;
    this.emitState();
    this.openExternal(r.verification_uri);
    this.pollDevice(flow, r.device_code, (r.interval || 5) * 1000);
    return this.state();
  }

  cancelDeviceLogin() {
    if (this.login) this.login.cancelled = true;
    this.login = null;
    this.emitState();
  }

  async pollDevice(flow, deviceCode, interval) {
    while (!flow.cancelled && Date.now() < flow.expiresAt) {
      await sleep(interval);
      if (flow.cancelled) return;
      let r;
      try {
        r = await this.request("POST", `${WEB()}/login/oauth/access_token`, {
          token: null,
          form: { client_id: GITHUB_APP.clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
        });
      } catch {
        continue; // network hiccup: keep polling until it expires
      }
      if (r.error === "authorization_pending") continue;
      if (r.error === "slow_down") {
        interval = (r.interval || interval / 1000 + 5) * 1000;
        continue;
      }
      this.login = null;
      if (r.access_token) {
        try {
          const user = await this.request("GET", API() + "/user", { token: r.access_token });
          this.saveAuth({ method: "app", login: user.login, token: r.access_token });
          return;
        } catch (e) {
          return this.emit("error", e.message);
        }
      }
      this.emitState();
      return this.emit("error", r.error === "access_denied" ? t("Login cancelado no GitHub.") : t("O código expirou. Tente de novo."));
    }
    if (!flow.cancelled) {
      this.login = null;
      this.emitState();
      this.emit("error", t("O código expirou. Tente de novo."));
    }
  }

  async setToken(token) {
    const clean = String(token || "").trim();
    if (!clean) throw new Error(t("Cole o token."));
    const user = await this.request("GET", API() + "/user", { token: clean }).catch((e) => {
      throw new Error(e.status === 401 ? t("Token inválido ou expirado.") : e.message);
    });
    this.saveAuth({ method: "token", login: user.login, token: clean });
    return this.state();
  }

  // Repositories the token can write to (an App token: those it's installed on).
  async repos() {
    const out = [];
    const add = (r) => out.push({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, canPush: r.permissions?.push !== false });
    if (this.auth?.method === "app") {
      const inst = await this.api("GET", "/user/installations?per_page=100");
      for (const i of inst.installations || []) {
        const r = await this.api("GET", `/user/installations/${i.id}/repositories?per_page=100`);
        (r.repositories || []).forEach(add);
      }
    } else {
      (await this.api("GET", "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member")).forEach(add);
    }
    return out.filter((r) => r.private && r.canPush).sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  // --- linking --------------------------------------------------------------------

  async workspace(id) {
    const w = (await this.util.call("app/workspaces")).find((x) => x.id === id);
    if (!w) throw new Error(t("Workspace não encontrado"));
    return w;
  }

  async checkRepo(full) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(full || "")) throw new Error(t("Informe o repositório como dono/nome."));
    let info;
    try {
      info = await this.api("GET", `/repos/${full}`);
    } catch (e) {
      if (e.status === 404) throw new Error(t("Repositório {repo} não encontrado, ou o acesso do Graphite não inclui ele.", { repo: full }));
      throw e;
    }
    if (!info.private) throw new Error(t("O repositório {repo} é público. O Graphite só sincroniza com repositórios privados.", { repo: full }));
    if (info.permissions && !info.permissions.push) throw new Error(t("Sem permissão de escrita em {repo}.", { repo: full }));
    return info;
  }

  async link(id, { repo, dir }) {
    const w = await this.workspace(id);
    const info = await this.checkRepo(repo);
    const folder = W.slug(dir || w.name);
    await this.util.call("app/setWorkspaceRemote", { id, remote: { repo: info.full_name, branch: info.default_branch, dir: folder, auto: true } });
    this.dropBase(w.uid);
    const r = await this.sync(id);
    this.remoteWorkspaces().catch(() => {});
    return r;
  }

  async unlink(id) {
    const w = await this.workspace(id);
    await this.util.call("app/setWorkspaceRemote", { id, remote: null });
    this.dropBase(w.uid);
    this.emit("changed", { id, remoteOnly: true });
    this.remoteWorkspaces().catch(() => {});
  }

  async setAuto(id, on) {
    const w = await this.workspace(id);
    if (!w.remote) return;
    await this.util.call("app/setWorkspaceRemote", { id, remote: { ...w.remote, auto: !!on } });
    this.emit("changed", { id, remoteOnly: true });
  }

  baseFile(uid) {
    return path.join(this.baseDir, `${uid}.json`);
  }
  readBase(uid, remote) {
    try {
      const b = JSON.parse(fs.readFileSync(this.baseFile(uid), "utf8"));
      return b.repo === remote.repo && b.dir === remote.dir ? b.doc : null;
    } catch {
      return null;
    }
  }
  writeBase(uid, remote, doc) {
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.writeFileSync(this.baseFile(uid), JSON.stringify({ repo: remote.repo, dir: remote.dir, doc }));
  }
  dropBase(uid) {
    try {
      fs.unlinkSync(this.baseFile(uid));
    } catch {}
  }

  // --- workspaces already in the repositories -----------------------------------------

  // Workspace folders (<dir>/workspace.yml) in the repositories this machine
  // can see: the ones local workspaces are linked to, plus those the GitHub
  // App is installed on (or `repo`, when given). Each says whether a local
  // workspace is already linked to it (`localId`). Emits "remote" with the list.
  async remoteWorkspaces({ repo } = {}) {
    if (!this.auth) return [];
    const local = await this.util.call("app/workspaces");
    const key = (r) => String(r).toLowerCase();
    const targets = new Map(); // repo → branch (null: default)
    if (repo) targets.set(key(repo), { full: repo, branch: null });
    else {
      for (const w of local) if (w.remote) targets.set(key(w.remote.repo), { full: w.remote.repo, branch: w.remote.branch || null });
      if (this.auth.method === "app") {
        const list = await this.repos().catch(() => []);
        for (const r of list.slice(0, 20)) if (!targets.has(key(r.fullName))) targets.set(key(r.fullName), { full: r.fullName, branch: null });
      }
    }
    const out = [];
    for (const { full, branch } of targets.values()) {
      let found;
      try {
        found = await this.scanRepo(full, branch);
      } catch (e) {
        if (repo) throw e;
        continue; // a linked repository gone or no longer reachable: its workspace shows the error
      }
      for (const f of found) {
        const w = local.find((x) => x.remote && key(x.remote.repo) === key(f.repo) && x.remote.dir === f.dir);
        out.push({ ...f, localId: w?.id ?? null });
      }
    }
    if (!repo) {
      this.remote = out;
      this.emit("remote", out);
    }
    return out;
  }

  async scanRepo(full, branchWanted) {
    const info = await this.checkRepo(full);
    const R = `/repos/${info.full_name}`;
    const branch = branchWanted || info.default_branch;
    const head = await this.headOf(R, branch);
    if (!head) return [];
    const treeSha = (await this.api("GET", `${R}/git/commits/${head}`)).tree.sha;
    const tree = await this.api("GET", `${R}/git/trees/${treeSha}?recursive=1`);
    const out = [];
    for (const e of tree.tree || []) {
      const m = e.type === "blob" && /^([^/]+)\/workspace\.yml$/.exec(e.path);
      if (!m) continue;
      const dir = m[1];
      let doc = null;
      try {
        const blob = await this.api("GET", `${R}/git/blobs/${e.sha}`);
        doc = W.fromFiles({ "workspace.yml": Buffer.from(blob.content, blob.encoding === "base64" ? "base64" : "utf8").toString("utf8") });
      } catch {
        continue; // not a valid workspace file
      }
      const queries = tree.tree.filter((x) => x.type === "blob" && x.path.startsWith(dir + "/queries/") && x.path.endsWith(".sql")).length;
      out.push({ repo: info.full_name, branch, dir, name: doc.name, connections: doc.connections.length, queries });
    }
    return out;
  }

  // Brings a workspace from the repository to this machine, linked to it. An
  // empty, unlinked local workspace is reused instead of making a second one:
  // one with the same name, or the only workspace of a fresh install (its
  // "Default" may carry another language's name).
  async openRemote({ repo, dir }) {
    const key = (r) => String(r).toLowerCase();
    const local = await this.util.call("app/workspaces");
    const linked = local.find((w) => w.remote && key(w.remote.repo) === key(repo) && w.remote.dir === dir);
    if (linked) return { id: linked.id, existed: true };
    const found = (await this.scanRepo(repo, null)).find((f) => f.dir === dir);
    if (!found) throw new Error(t("Não achei o workspace {dir} em {repo}.", { dir, repo }));
    const isEmpty = (w) => !w.remote && !w.connections && !w.queries && !(w.snippets || []).length;
    const empty = local.find((w) => isEmpty(w) && w.name === found.name) || (local.length === 1 && isEmpty(local[0]) ? local[0] : null);
    const id = empty ? empty.id : await this.util.call("app/saveWorkspace", { workspace: { name: found.name } });
    if (empty && empty.name !== found.name) await this.util.call("app/saveWorkspace", { workspace: { id, name: found.name } });
    await this.util.call("app/setWorkspaceRemote", { id, remote: { repo: found.repo, branch: found.branch, dir, auto: true } });
    const w = await this.workspace(id);
    this.dropBase(w.uid);
    try {
      await this.sync(id);
    } catch (e) {
      if (!empty) await this.util.call("app/deleteWorkspace", { id }).catch(() => {});
      else {
        await this.util.call("app/setWorkspaceRemote", { id, remote: null }).catch(() => {});
        await this.util.call("app/saveWorkspace", { workspace: { id, name: empty.name } }).catch(() => {});
      }
      throw e;
    }
    this.remoteWorkspaces().catch(() => {});
    return { id, existed: false };
  }

  // --- sync --------------------------------------------------------------------------

  // One sync at a time per workspace; a second call waits for the first.
  // Emits "syncing" so the UI shows background syncs too.
  sync(id) {
    const prev = this.locks.get(id) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => {
      this.emit("syncing", { id, on: true });
      return this.doSync(id);
    });
    this.locks.set(id, run);
    run
      .finally(() => {
        if (this.locks.get(id) !== run) return;
        this.locks.delete(id);
        this.emit("syncing", { id, on: false });
      })
      .catch(() => {});
    return run;
  }

  async doSync(id, attempt = 0) {
    const w = await this.workspace(id);
    const remote = w.remote;
    if (!remote) throw new Error(t("Este workspace não está ligado a um repositório."));
    try {
      const result = await this.syncOnce(w, remote, attempt);
      await this.util.call("app/setWorkspaceRemote", { id, remote: { ...remote, branch: result.branch, lastSha: result.sha, lastSyncAt: new Date().toISOString(), lastError: null } });
      this.emit("changed", { id, pulled: result.pulled });
      return result;
    } catch (e) {
      if (e.retry && attempt < 2) return this.doSync(id, attempt + 1);
      await this.util.call("app/setWorkspaceRemote", { id, remote: { ...remote, lastError: e.message } }).catch(() => {});
      this.emit("changed", { id, remoteOnly: true });
      throw e;
    }
  }

  async headOf(R, branch) {
    try {
      return (await this.api("GET", `${R}/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha;
    } catch (e) {
      if (e.status === 404 || e.status === 409) return null; // missing branch / empty repository
      throw e;
    }
  }

  async syncOnce(w, remote) {
    const info = await this.checkRepo(remote.repo);
    const R = `/repos/${info.full_name}`;
    const branch = remote.branch || info.default_branch;
    const head = await this.headOf(R, branch);

    // The workspace as it is in the repository.
    let treeSha = null;
    const existing = {}; // repo path → blob sha, for our files under dir
    let remoteDoc = null;
    if (head) {
      treeSha = (await this.api("GET", `${R}/git/commits/${head}`)).tree.sha;
      const tree = await this.api("GET", `${R}/git/trees/${treeSha}?recursive=1`);
      if (tree.truncated) throw new Error(t("O repositório é grande demais para sincronizar. Use um repositório só para workspaces."));
      const prefix = remote.dir + "/";
      const files = {};
      for (const e of tree.tree) {
        if (e.type !== "blob" || !e.path.startsWith(prefix) || !OURS.test(e.path.slice(prefix.length))) continue;
        existing[e.path] = e.sha;
        const blob = await this.api("GET", `${R}/git/blobs/${e.sha}`);
        files[e.path.slice(prefix.length)] = Buffer.from(blob.content, blob.encoding === "base64" ? "base64" : "utf8").toString("utf8");
      }
      remoteDoc = W.fromFiles(files);
    }

    const local = await this.util.call("app/workspaceDoc", { id: w.id });
    const base = this.readBase(w.uid, remote);
    const { doc, conflicts } = W.merge3(base, local, remoteDoc);
    let pulled = false;
    if (!W.same(doc, local)) {
      await this.util.call("app/applyWorkspaceDoc", { id: w.id, doc });
      pulled = true;
    }
    const final = pulled ? await this.util.call("app/workspaceDoc", { id: w.id }) : local;

    // Files to write or delete.
    const want = W.toFiles(final, remote.dir);
    const tree = [];
    for (const [p, content] of Object.entries(want)) if (existing[p] !== gitBlobSha(content)) tree.push({ path: p, mode: "100644", type: "blob", content });
    for (const p of Object.keys(existing)) if (!(p in want)) tree.push({ path: p, mode: "100644", type: "blob", sha: null });

    let sha = head;
    if (tree.length) {
      const message = t("Graphite: sincroniza o workspace \"{name}\"", { name: final.name });
      let newTree;
      try {
        newTree = await this.api("POST", `${R}/git/trees`, { body: treeSha ? { base_tree: treeSha, tree } : { tree: tree.filter((e) => e.sha !== null) } });
      } catch (e) {
        // An empty repository has no git database yet: the contents API makes the first commit.
        if (e.status === 409 && !head) {
          await this.api("PUT", `${R}/contents/${remote.dir}/workspace.yml`, {
            body: { message, content: Buffer.from(want[`${remote.dir}/workspace.yml`]).toString("base64"), branch },
          });
          throw Object.assign(new Error("retry"), { retry: true });
        }
        throw e;
      }
      const commit = await this.api("POST", `${R}/git/commits`, { body: { message, tree: newTree.sha, parents: head ? [head] : [] } });
      try {
        if (head) await this.api("PATCH", `${R}/git/refs/heads/${encodeURIComponent(branch)}`, { body: { sha: commit.sha } });
        else await this.api("POST", `${R}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
      } catch (e) {
        // Someone pushed in between: start over from the new head.
        if (e.status === 422 || e.status === 409) throw Object.assign(new Error(e.message), { retry: true });
        throw e;
      }
      sha = commit.sha;
    }
    this.writeBase(w.uid, remote, final);
    return { pulled, pushed: tree.length > 0, files: tree.length, conflicts, sha, branch };
  }

  // --- automatic sync -------------------------------------------------------------------

  start() {
    setTimeout(() => this.syncAll(), 8000).unref?.();
    setInterval(() => this.syncAll(), AUTO_EVERY).unref?.();
  }

  async syncAll() {
    if (!this.auth) return;
    let list = [];
    try {
      list = await this.util.call("app/workspaces");
    } catch {
      return;
    }
    for (const w of list) if (w.remote && w.remote.auto !== false) await this.sync(w.id).catch(() => {});
    await this.remoteWorkspaces().catch(() => {});
  }

  // A local change: sync a little later, once edits settle.
  touch(id) {
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(async () => {
      this.timers.delete(id);
      const w = await this.workspace(id).catch(() => null);
      if (this.auth && w?.remote && w.remote.auto !== false) this.sync(id).catch(() => {});
    }, AUTO_AFTER_EDIT));
  }
}

module.exports = { GitHubSync, GITHUB_APP, gitBlobSha };
