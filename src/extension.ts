import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Kalo for VS Code, first pass: open a course project here.
 *
 * A project lesson on kalo.gg has an "Open in VS Code" button that opens
 * vscode://ryancundiff.kalo-vscode/open?course=…&module=…&lesson=… . This extension
 * answers that link (and the "Kalo: Open a course project" command) by
 * fetching the project's starter files from the site, writing them into a
 * folder of their own, and opening it with the entry file showing. Tasks are
 * still checked on the site; nothing here talks to an account.
 */
const SITE = "https://kalo.gg";
const PENDING_KEY = "kalo.pendingOpen";

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

interface Pending {
  folder: string;
  entry: string | null;
  title: string;
  url: string;
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerUriHandler({ handleUri: (uri) => void openFromUri(context, uri) }),
    vscode.commands.registerCommand("kalo.openProject", () => void openFromPrompt(context)),
  );
  // The window may have just been reopened on a project we set up: finish the job.
  void finishPendingOpen(context);
}

export function deactivate() {}

async function openFromUri(context: vscode.ExtensionContext, uri: vscode.Uri) {
  const q = new URLSearchParams(uri.query);
  const course = q.get("course");
  const module = q.get("module");
  const lesson = q.get("lesson");
  if (!course || !module || !lesson || ![course, module, lesson].every(isSlug)) {
    void vscode.window.showErrorMessage("That Kalo link does not name a project.");
    return;
  }
  await openProject(context, course, module, lesson);
}

async function openFromPrompt(context: vscode.ExtensionContext) {
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
  await openProject(context, course, module, lesson);
}

function isSlug(s: string): boolean {
  return s.length > 0 && s.length <= 64 && [...s].every((c) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-");
}

/** A path inside the folder, whatever the manifest says. */
function safeJoin(folder: string, rel: string): string | null {
  const full = path.resolve(folder, rel);
  return full === folder || full.startsWith(folder + path.sep) ? full : null;
}

async function openProject(context: vscode.ExtensionContext, course: string, module: string, lesson: string) {
  let manifest: Manifest;
  try {
    const res = await fetch(`${SITE}/projects/${course}/${module}/${lesson}`);
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
    for (const f of manifest.files) {
      const full = safeJoin(folder, f.path);
      if (!full) continue;
      if (f.path.endsWith("/") || f.content === null) {
        await fs.mkdir(full, { recursive: true });
        continue;
      }
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, f.content, "utf8");
    }
    // What this folder is, for a later version that can check tasks or sync progress.
    const about = { ...manifest, files: undefined };
    await fs.writeFile(path.join(folder, ".kalo.json"), JSON.stringify(about, null, 2), "utf8");
  }

  const entryRel = manifest.entry ?? manifest.project;
  const entry = entryRel ? safeJoin(folder, entryRel) : null;
  const pending: Pending = { folder, entry, title: manifest.title, url: manifest.url };
  await context.globalState.update(PENDING_KEY, pending);

  if (vscode.workspace.workspaceFolders?.some((w) => w.uri.fsPath === folder)) {
    await finishPendingOpen(context);
    return;
  }
  // Opening a folder restarts the extension host; activate() picks the rest up.
  const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(folder), { forceNewWindow: hasWorkspace });
}

async function finishPendingOpen(context: vscode.ExtensionContext) {
  const pending = context.globalState.get<Pending>(PENDING_KEY);
  if (!pending) return;
  // Only the window that has the folder finishes it; another window leaves it be.
  if (!vscode.workspace.workspaceFolders?.some((w) => w.uri.fsPath === pending.folder)) return;
  await context.globalState.update(PENDING_KEY, undefined);
  if (pending.entry) {
    try {
      const doc = await vscode.workspace.openTextDocument(pending.entry);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch {
      /* the entry file is optional; the folder is open either way */
    }
  }
  const pick = await vscode.window.showInformationMessage(`${pending.title} is ready. Tasks are checked on kalo.gg.`, "Open the lesson");
  if (pick) await vscode.env.openExternal(vscode.Uri.parse(pending.url));
}
