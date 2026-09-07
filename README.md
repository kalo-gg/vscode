# Kalo for VS Code

Do [Kalo](https://kalo.gg) course projects in your own editor.

A project lesson on kalo.gg has an **Open in VS Code** button. With this
extension installed, that button fetches the project's starter files, puts
them in a folder of their own and opens it, with the entry file showing.
Tasks are still checked on the site.

There is also a command, **Kalo: Open a course project**, which asks for the
project's address (`course/module/lesson`, as in the lesson's URL).

## Where the files go

`~/kalo/<course>/<lesson>` by default. Set `kalo.projectsFolder` to use another
root. Opening a project again offers to keep what is there or put the starter
files back.

## Installing

Until it is on the marketplace, build it and install the `.vsix`:

```sh
npm install
npm run compile
npm run package   # writes kalo-<version>.vsix
code --install-extension kalo-0.1.0.vsix
```

## What it does not do yet

No sign-in, no progress sync, no checking tasks from the editor. Those are
later passes; the site is where tasks are graded.
