# Kalo Projects

Do [Kalo](https://kalo.gg) course projects in your own editor.

A project lesson on kalo.gg has an **Open in VS Code** button. With this
extension installed, that button fetches the project's starter files, puts
them in a folder of their own and opens it, with the entry file showing.
Tasks are still checked on the site.

There is also a command, **Kalo: Open a course project**, which asks for the
project's address (`course/module/lesson`, as in the lesson's URL).

## Sending your work back

Run **Kalo: Sign in**. It opens kalo.gg with a code; approve it there and the
editor is connected to your account. From then on every save sends the
project's files to your account (turn that off with `kalo.syncOnSave`), and
**Kalo: Send project to kalo.gg** does it on demand. Open the lesson and it
picks up your files; check the tasks there. Signed-in editors are listed on
your account page, where you can sign them out.

## Where the files go

`~/kalo/<course>/<lesson>` by default. Set `kalo.projectsFolder` to use another
root. Opening a project again offers to keep what is there or put the starter
files back.

## Installing

Download the `.vsix` from the [latest release](https://github.com/kalo-gg/vscode/releases/latest)
and install it from the Extensions view (**...** > **Install from VSIX...**), or:

```sh
code --install-extension kalo-0.2.0.vsix
```

To build it yourself, `npm install`, `npm run compile`, then `npm run package`.

## What it does not do yet

No checking tasks from the editor: the site is where tasks are graded.
