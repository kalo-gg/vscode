# Changelog

## 0.2.0

- **Kalo: Sign in** connects the editor to your kalo.gg account with a code you approve in the browser. Signed-in editors are listed on the account page, where they can be signed out.
- Every save sends the project's files to your account (`kalo.syncOnSave`, on by default), and **Kalo: Send project to kalo.gg** does it on demand. The lesson page picks the files up; tasks are still checked there.
- Opening a project while signed in starts from the files saved on your account, when there are any.
- A status bar item shows who is signed in and when the project was last sent.

## 0.1.0

- **Open in VS Code** from a Kalo project lesson fetches the project's starter files into a folder of their own and opens it.
- **Kalo: Open a course project** asks for a project's address (`course/module/lesson`) and does the same.
- Projects with a static runtime (Larvae, LuauX, pesde) open like any other.
