import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Kalo Projects: do a Kalo course project in VS Code.
 *
 * Opening: a project lesson on kalo.gg has an "Open in VS Code" button that
 * opens vscode://ryancundiff.kalo-projects/open?course=…&module=…&lesson=… .
 * This extension answers that link (and the "Kalo: Open a course project"
 * command) by fetching the project's starter files from the site, writing
 * them into a folder of their own, and opening it with the entry file
 * showing. A `.kalo.json` in the folder says which lesson it is.
 *
 * Sending: signed in ("Kalo: Sign in", a code approved on the site), the
 * project's files go to the account on every save, or on "Kalo: Send project
 * to kalo.gg". The lesson page picks them up, and that is where the tasks
 * are checked. Nothing is graded here.
 */
const PENDING_KEY = "kalo.pendingOpen";
const TOKEN_KEY = "kalo.token";
const TOKEN_ID_KEY = "kalo.tokenId";
const USER_KEY = "kalo.user";

/** What the site lets a project hold; larger is refused there, so it is not sent. */
const MAX_FILES = 64;
const MAX_FILE_BYTES = 100 * 1024;
/** Folders never sent: tooling, dependencies, build output, the marker itself. */
const SKIP_DIRS = new Set([".git", "node_modules", ".vscode", "out", "target", "dist", "build", ".lest", ".larvae"]);
const SKIP_FILES = new Set([".kalo.json", ".DS_Store", "Thumbs.db"]);

interface Manifest {
  course: string;
  module: string;
  lesson: string;
  title: string;
  courseTitle: string;
  url: string;
  /** "static" is a project with no runtime at all (the tool courses); nothing here branches on the value. */
  runtime: "luau" | "rojo" | "static";
  entry: string | null;
  project: string | null;
  readOnly: string[];
  files: { path: string; content: string | null }[];
  tasks: { id: string; title: string; detail: string | null; file: string | null }[];
}

/** `.kalo.json`: the manifest minus the files. */
type About = Omit<Manifest, "files">;

interface Pending {
  folder: string;
  entry: string | null;
  title: string;
  url: string;
}

interface SignedIn {
  username: string;
  displayName: string;
}

function site(): string {
  return (vscode.workspace.getConfiguration("kalo").get<string>("site") || "https://kalo.gg").replace(/\/$/, "");
}

function api(): string {
  return (vscode.workspace.getConfiguration("kalo").get<string>("api") || "https://api.kalo.gg").replace(/\/$/, "");
}

let status: vscode.StatusBarItem;
let ext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext) {
  ext = context;
  status = vscode.window.createStatusBarItem("kalo", vscode.StatusBarAlignment.Right, 50);
  status.name = "Kalo";
  context.subscriptions.push(
    status,
    vscode.window.registerUriHandler({ handleUri: (uri) => void openFromUri(uri) }),
    vscode.commands.registerCommand("kalo.openProject", () => void openFromPrompt()),
    vscode.commands.registerCommand("kalo.signIn", () => void signIn()),
    vscode.commands.registerCommand("kalo.signOut", () => void signOut()),
    vscode.commands.registerCommand("kalo.sendProject", () => void sendProjectCommand()),
    vscode.workspace.onDidSaveTextDocument((doc) => void onSaved(doc)),
  );
  void showStatus();
  // The window may have just been reopened on a project we set up: finish the job.
  void finishPendingOpen();
}

export function deactivate() {}

/* ------------------------------------------------------------------ */
/* Opening a project                                                   */
/* ------------------------------------------------------------------ */

async function openFromUri(uri: vscode.Uri) {
  const q = new URLSearchParams(uri.query);
  const course = q.get("course");
  const module = q.get("module");
  const lesson = q.get("lesson");
  if (!course || !module || !lesson || ![course, module, lesson].every(isSlug)) {
    void vscode.window.showErrorMessage("That Kalo link does not name a project.");
    return;
  }
  await openProject(course, module, lesson);
}

async function openFromPrompt() {
  const value = await vscode.window.showInputBox({
    title: "Kalo: open a course project",
    prompt: "The project's address on kalo.gg, after /courses/",
    placeHolder: "jecs/mastery/project-wave-survival",
    validateInput: (v) => {
      const parts = v.trim().split("/");
      return parts.length === 3 && parts.every(isSlug) ? undefined : "course/module/lesson, as in the lesson's address";
    },
  });
  if (!value) return;
  const [course, module, lesson] = value.trim().split("/");
  await openProject(course, module, lesson);
}

function isSlug(s: string): boolean {
  return s.length > 0 && s.length <= 64 && [...s].every((c) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-");
}

/** A path inside the folder, whatever the manifest says. */
function safeJoin(folder: string, rel: string): string | null {
  const full = path.resolve(folder, rel);
  return full === folder || full.startsWith(folder + path.sep) ? full : null;
}

async function openProject(course: string, module: string, lesson: string) {
  let manifest: Manifest;
  try {
    const res = await fetch(`${site()}/projects/${course}/${module}/${lesson}`);
    if (!res.ok) throw new Error(res.status === 404 ? "there is no project at that address" : `kalo.gg answered ${res.status}`);
    manifest = (await res.json()) as Manifest;
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not fetch that project from Kalo: ${e instanceof Error ? e.message : String(e)}.`);
    return;
  }

  const configured = vscode.workspace.getConfiguration("kalo").get<string>("projectsFolder")?.trim();
  const root = configured ? configured : path.join(os.homedir(), "kalo");
  const folder = path.resolve(root, manifest.course, manifest.lesson);

  const existing = await fs.readdir(folder).catch(() => null);
  let writeFiles = true;
  if (existing && existing.length > 0) {
    const choice = await vscode.window.showWarningMessage(`${folder} already has files in it.`, { modal: true }, "Open it as it is", "Put the starter files back");
    if (!choice) return;
    writeFiles = choice === "Put the starter files back";
  }

  if (writeFiles) {
    await fs.mkdir(folder, { recursive: true });
    // Signed in, the account's saved copy wins over the starter: it is the
    // work in progress, from this editor or from the site.
    const saved = await fetchSavedFiles(manifest.course, manifest.module, manifest.lesson);
    for (const f of manifest.files) {
      const full = safeJoin(folder, f.path);
      if (!full) continue;
      if (f.path.endsWith("/") || f.content === null) {
        await fs.mkdir(full, { recursive: true });
        continue;
      }
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, saved?.[f.path] ?? f.content, "utf8");
    }
    for (const [rel, content] of Object.entries(saved ?? {})) {
      if (manifest.files.some((f) => f.path === rel)) continue;
      const full = safeJoin(folder, rel);
      if (!full) continue;
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf8");
    }
    const { files: _files, ...about } = manifest;
    await fs.writeFile(path.join(folder, ".kalo.json"), JSON.stringify(about, null, 2), "utf8");
    if (saved) void vscode.window.showInformationMessage("Picked up the files saved on your Kalo account.");
  }

  const entryRel = manifest.entry ?? manifest.project;
  const entry = entryRel ? safeJoin(folder, entryRel) : null;
  const pending: Pending = { folder, entry, title: manifest.title, url: manifest.url };
  await ext.globalState.update(PENDING_KEY, pending);

  if (vscode.workspace.workspaceFolders?.some((w) => w.uri.fsPath === folder)) {
    await finishPendingOpen();
    return;
  }
  // Opening a folder restarts the extension host; activate() picks the rest up.
  const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(folder), { forceNewWindow: hasWorkspace });
}

async function finishPendingOpen() {
  const pending = ext.globalState.get<Pending>(PENDING_KEY);
  if (!pending) return;
  // Only the window that has the folder finishes it; another window leaves it be.
  if (!vscode.workspace.workspaceFolders?.some((w) => w.uri.fsPath === pending.folder)) return;
  await ext.globalState.update(PENDING_KEY, undefined);
  if (pending.entry) {
    try {
      const doc = await vscode.workspace.openTextDocument(pending.entry);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch {
      /* the entry file is optional; the folder is open either way */
    }
  }
  const signedIn = ext.globalState.get<SignedIn>(USER_KEY);
  const hint = signedIn ? "Saves go to your Kalo account; tasks are checked on the lesson page." : "Sign in with Kalo: Sign in and every save reaches the lesson page.";
  const pick = await vscode.window.showInformationMessage(`${pending.title} is ready. ${hint}`, "Open the lesson");
  if (pick) await vscode.env.openExternal(vscode.Uri.parse(pending.url));
}

/* ------------------------------------------------------------------ */
/* Signing in                                                          */
/* ------------------------------------------------------------------ */

async function token(): Promise<string | undefined> {
  return ext.secrets.get(TOKEN_KEY);
}

async function showStatus(text?: string, tooltip?: string) {
  const user = ext.globalState.get<SignedIn>(USER_KEY);
  const signedIn = !!(await token()) && !!user;
  if (!signedIn) {
    status.text = "$(account) Kalo: Sign in";
    status.tooltip = "Sign in to send project files to your Kalo account";
    status.command = "kalo.signIn";
  } else {
    status.text = text ?? `$(cloud) Kalo: @${user.username}`;
    status.tooltip = tooltip ?? "Send this project to kalo.gg";
    status.command = "kalo.sendProject";
  }
  status.show();
}

async function signIn() {
  const label = `VS Code on ${os.hostname()}`;
  let start: { deviceCode: string; userCode: string; verifyUrl: string; expiresIn: number; interval: number };
  try {
    const res = await fetch(`${api()}/api/device`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label }) });
    if (!res.ok) throw new Error(`kalo.gg answered ${res.status}`);
    start = (await res.json()) as typeof start;
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not start signing in to Kalo: ${e instanceof Error ? e.message : String(e)}.`);
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(start.verifyUrl));

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Kalo: approve code ${start.userCode} in your browser`, cancellable: true },
    async (_progress, cancel) => {
      const deadline = Date.now() + start.expiresIn * 1000;
      while (Date.now() < deadline && !cancel.isCancellationRequested) {
        await new Promise((r) => setTimeout(r, Math.max(2, start.interval) * 1000));
        if (cancel.isCancellationRequested) return null;
        let res: Response;
        try {
          res = await fetch(`${api()}/api/device/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceCode: start.deviceCode }) });
        } catch {
          continue; // a blip; the code is still live
        }
        if (res.status === 404) return "expired";
        if (!res.ok) continue;
        const body = (await res.json()) as { pending?: boolean; token?: string; tokenId?: string; user?: { username: string; displayName: string } };
        if (body.token && body.user) return body as { token: string; tokenId?: string; user: { username: string; displayName: string } };
      }
      return cancel.isCancellationRequested ? null : "expired";
    },
  );

  if (result === null) return;
  if (result === "expired") {
    void vscode.window.showWarningMessage("That sign-in code expired before it was approved. Run Kalo: Sign in again.");
    return;
  }
  await ext.secrets.store(TOKEN_KEY, result.token);
  await ext.globalState.update(TOKEN_ID_KEY, result.tokenId ?? null);
  await ext.globalState.update(USER_KEY, { username: result.user.username, displayName: result.user.displayName } satisfies SignedIn);
  await showStatus();
  const project = await projectForActiveEditor();
  const pick = await vscode.window.showInformationMessage(`Signed in to Kalo as @${result.user.username}.`, ...(project ? ["Send this project"] : []));
  if (pick && project) await sendProject(project, true);
}

async function signOut() {
  const t = await token();
  const id = ext.globalState.get<string | null>(TOKEN_ID_KEY);
  if (t && id) {
    // Best effort: the token is gone from here either way.
    await fetch(`${api()}/api/tokens/${encodeURIComponent(id)}`, { method: "DELETE", headers: { authorization: `Bearer ${t}` } }).catch(() => undefined);
  }
  await ext.secrets.delete(TOKEN_KEY);
  await ext.globalState.update(TOKEN_ID_KEY, undefined);
  await ext.globalState.update(USER_KEY, undefined);
  await showStatus();
  void vscode.window.showInformationMessage("Signed out of Kalo.");
}

/** The token is no longer accepted: forget it, and say why saves stopped. */
async function tokenRejected() {
  await ext.secrets.delete(TOKEN_KEY);
  await ext.globalState.update(TOKEN_ID_KEY, undefined);
  await ext.globalState.update(USER_KEY, undefined);
  await showStatus();
  const pick = await vscode.window.showWarningMessage("Kalo signed this editor out (the token was revoked or expired).", "Sign in again");
  if (pick) void signIn();
}

/* ------------------------------------------------------------------ */
/* Sending a project                                                   */
/* ------------------------------------------------------------------ */

interface Project {
  folder: string;
  about: About;
}

/** The project a file belongs to: the nearest folder up from it with a `.kalo.json`, inside the workspace. */
async function projectFor(file: string): Promise<Project | null> {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((w) => w.uri.fsPath);
  let dir = path.dirname(file);
  for (;;) {
    if (!roots.some((r) => dir === r || dir.startsWith(r + path.sep))) return null;
    const about = await readAbout(dir);
    if (about) return { folder: dir, about };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function readAbout(folder: string): Promise<About | null> {
  try {
    const about = JSON.parse(await fs.readFile(path.join(folder, ".kalo.json"), "utf8")) as Partial<About>;
    if (about && [about.course, about.module, about.lesson].every((s) => typeof s === "string" && isSlug(s))) return about as About;
  } catch {
    /* not a Kalo project folder */
  }
  return null;
}

async function projectForActiveEditor(): Promise<Project | null> {
  const active = vscode.window.activeTextEditor?.document;
  if (active && active.uri.scheme === "file") {
    const p = await projectFor(active.uri.fsPath);
    if (p) return p;
  }
  for (const w of vscode.workspace.workspaceFolders ?? []) {
    const about = await readAbout(w.uri.fsPath);
    if (about) return { folder: w.uri.fsPath, about };
  }
  return null;
}

/** Every file worth sending, as project-relative paths with forward slashes. */
async function collectFiles(folder: string): Promise<{ files: Record<string, string>; skipped: number }> {
  const files: Record<string, string> = {};
  let skipped = 0;
  async function walk(dir: string, rel: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), childRel);
        continue;
      }
      if (!entry.isFile() || SKIP_FILES.has(entry.name)) continue;
      if (Object.keys(files).length >= MAX_FILES) {
        skipped++;
        continue;
      }
      const buf = await fs.readFile(path.join(dir, entry.name)).catch(() => null);
      if (!buf || buf.length > MAX_FILE_BYTES || buf.includes(0)) {
        skipped++;
        continue;
      }
      files[childRel] = buf.toString("utf8");
    }
  }
  await walk(folder, "");
  return { files, skipped };
}

/** Sends run one at a time per project; a save during a send queues one more. */
const inFlight = new Map<string, Promise<void>>();
const queued = new Set<string>();

async function sendProject(project: Project, announce: boolean) {
  const t = await token();
  if (!t) {
    if (announce) {
      const pick = await vscode.window.showInformationMessage("Sign in to Kalo first, then the project can be sent.", "Sign in");
      if (pick) void signIn();
    }
    return;
  }
  if (inFlight.has(project.folder)) {
    queued.add(project.folder);
    return;
  }
  const run = (async () => {
    const { about } = project;
    const { files, skipped } = await collectFiles(project.folder);
    if (Object.keys(files).length === 0) {
      if (announce) void vscode.window.showWarningMessage("There are no files to send in this project.");
      return;
    }
    void showStatus("$(cloud-upload) Kalo: sending…", `Sending ${Object.keys(files).length} files to kalo.gg`);
    try {
      const res = await fetch(`${api()}/api/projects/${about.course}/${about.module}/${about.lesson}`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
        body: JSON.stringify({ files, source: "vscode" }),
      });
      if (res.status === 401) {
        await tokenRejected();
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `kalo.gg answered ${res.status}`);
      }
      const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      void showStatus(`$(cloud) Kalo: sent ${time}`, `${Object.keys(files).length} files on kalo.gg as of ${time}`);
      if (announce) {
        const note = skipped ? ` (${skipped} left out: too large, binary, or past the limit)` : "";
        const pick = await vscode.window.showInformationMessage(`Sent ${Object.keys(files).length} files to kalo.gg${note}.`, "Open the lesson");
        if (pick) await vscode.env.openExternal(vscode.Uri.parse(about.url));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      void showStatus("$(cloud-offline) Kalo: not sent", `Could not send: ${message}`);
      if (announce) void vscode.window.showErrorMessage(`Could not send the project to Kalo: ${message}.`);
    }
  })();
  inFlight.set(project.folder, run);
  try {
    await run;
  } finally {
    inFlight.delete(project.folder);
    if (queued.delete(project.folder)) void sendProject(project, false);
  }
}

async function sendProjectCommand() {
  const project = await projectForActiveEditor();
  if (!project) {
    void vscode.window.showWarningMessage("No Kalo project is open. Open one from a lesson page, or with Kalo: Open a course project.");
    return;
  }
  await sendProject(project, true);
}

/** Save-triggered sends, one per project after a short pause. */
const saveTimers = new Map<string, NodeJS.Timeout>();

async function onSaved(doc: vscode.TextDocument) {
  if (doc.uri.scheme !== "file") return;
  if (!vscode.workspace.getConfiguration("kalo").get<boolean>("syncOnSave", true)) return;
  if (!(await token())) return;
  const project = await projectFor(doc.uri.fsPath);
  if (!project) return;
  const existing = saveTimers.get(project.folder);
  if (existing) clearTimeout(existing);
  saveTimers.set(
    project.folder,
    setTimeout(() => {
      saveTimers.delete(project.folder);
      void sendProject(project, false);
    }, 1500),
  );
}

/** The account's saved copy of a project, if signed in and there is one. */
async function fetchSavedFiles(course: string, module: string, lesson: string): Promise<Record<string, string> | null> {
  const t = await token();
  if (!t) return null;
  try {
    const res = await fetch(`${api()}/api/projects/${course}/${module}/${lesson}`, { headers: { authorization: `Bearer ${t}` } });
    if (res.status === 401) {
      await tokenRejected();
      return null;
    }
    if (!res.ok) return null;
    const body = (await res.json()) as { files?: Record<string, string> };
    return body.files && Object.keys(body.files).length > 0 ? body.files : null;
  } catch {
    return null;
  }
}
