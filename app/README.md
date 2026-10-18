# DeepSeek Bot desktop app

The Electron app for Windows and macOS. It installs a pinned DeepSeek Harness (DSH 0.2.1-rc.2) and the `ds-bot` plugin of this repository, boots its own DSH profile `ds-bot` through `@deepseek-ai/dsh/profile-boot`, and keeps its data in its own `DSH_HOME`. It never writes to `~/.dsh`. Its window shows DSH's Web front end with the plugin, as DSH Desktop does. The design is in [docs/plans/2026-10-16-desktop-app.md](../docs/plans/2026-10-16-desktop-app.md).

## Run

```sh
npm ci
node node_modules/electron/install.js   # when npm did not download Electron (no node_modules/electron/dist)
npm start                               # starts the app
```

When GitHub downloads are slow, set `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` before the Electron download. Unset `ELECTRON_RUN_AS_NODE` before `npm start` if your terminal has it (terminals inside some Electron-based editors do): with it, Electron runs as plain Node and the app does not start.

npm installs `ds-bot` from `../ds-bot` as a copy of its package files (`install-links` in `.npmrc`), so the app runs the plugin of this checkout. Run `npm ci` again after you change `ds-bot` or merge a branch that changes it: while the version stays the same, `npm install` keeps the old copy. `overrides` in `package.json` pins the four peer dependencies of `ds-bot` to the DSH version: they are declared as `*`, and npm does not choose a pre-release to satisfy `*`.

| Variable | What it sets | Default |
|---|---|---|
| `DS_BOT_HOME` | The data location: the `DSH_HOME` of the app. When it is set, the app asks nothing at its first start and imports nothing | The folder chosen at the first start |
| `DS_BOT_WORKSPACE` | With `DS_BOT_HOME`: the folder for the files that Bots make | `bot/workspace` in the data location |
| `DS_BOT_SHELL_DATA` | The app's own data (window, Chromium storage, `locations.json`) | Electron's `userData` (Windows: `%APPDATA%\DeepSeek Bot`) |

## First start and import

At its first start the app asks, in system dialogs, for the data location (`~/.ds-bot` by default) and the folder for the files that Bots make (`~/DeepSeek Bot`), and keeps the answer in `locations.json` in its own data. Neither folder may be inside the other or inside the user's DSH data.

When the user's DSH (`DSH_HOME`, else `~/.dsh`) has a Bot team, the app offers to copy it (`src/import.mjs`). It only reads there. Before the copy it checks that no running DSH holds the team and that no chat is in a newer session format than the pinned DSH reads, and it starts the Host once on the new data location, so that DSH does not register the copied Sessions' folders as projects. The copy takes `bot/` (without its lock, turns in flight and workspace), every Session the team names, the attachments, `.credentials.yaml`, `.env`, the model rows of one profile's `cordis.patch.yml`, and the old team workspace's files, which go into the new folder without replacing a file there. `bot/imported.json` records it. At its next turn, each Bot and group moves on to a fresh part in the new folder.

The Host reads model settings and keys the way DSH does: environment variables such as `DEEPSEEK_API_KEY`, and `.env` and `.credentials.yaml` in the data location. DSH's settings in the window set up model providers and their keys; DSH keeps the providers in the profile's `cordis.patch.yml` and the keys in `.credentials.yaml`.

## The profile

The Host's profile `ds-bot` is in `profiles/ds-bot` in the data location. It stacks three bundles, and after them the bundles that the user installs:

| Bundle | What it adds |
|---|---|
| `@deepseek-ai/dsh-base` | DSH's shared core: models, Sessions, tools, settings, plugin management |
| `@deepseek-ai/dsh-web-app` | DSH's Web front end, which the window shows, and the host services that it and ds-bot use |
| `ds-bot` | The Bot team |

At every start the Host puts these three bundles at the head of the profile's bundle list. Settings for one machine go into the profile's `cordis.patch.yml`, as in DSH. A profile from an earlier build that lists `deepseek-bot-engine` gets `@deepseek-ai/dsh-web-app` in its place.

## Check a change

`npm test` checks the composition of the profile, the import on throwaway folders, and that every package the app runs on is a dependency (see [Package](#package)).

`scripts/shot.mjs` starts the app on throwaway folders, saves a screenshot of its window, prints the page text, closes the window the way a user does and waits until the app exits. Use the mock model of the plugin, `../ds-bot/dev/mock-llm.mjs` (`MOCK_PORT=<port> node ../ds-bot/dev/mock-llm.mjs`).

```sh
DS_BOT_HOME=<tmp>/home DS_BOT_SHELL_DATA=<tmp>/shell \
DEEPSEEK_BASE_URL=http://127.0.0.1:<port>/v1 DEEPSEEK_API_KEY=mock-key \
node scripts/shot.mjs <tmp>/shot.png 20
```

Never point `DS_BOT_HOME` at `~/.dsh` or at the data of an app that you use.

## Package

[electron-builder](https://www.electron.build/) packages the app with the settings in `electron-builder.yml`. Build on the platform that you package for: the native modules (`node-pty`, `sharp`, `koffi`) are taken from `node_modules` as npm installed them, not rebuilt.

```sh
npm run pack           # the app without an installer: dist-pack/win-unpacked/ (Windows), dist-pack/mac*/ (macOS)
npm run dist           # the installer: dist-pack/DeepSeek-Bot-<version>-win-x64.exe (Windows), a .dmg (macOS)
npm run check-packed   # starts the packaged app on throwaway folders with the mock model, chats once, closes it
```

`check-packed` takes another executable as its first argument, and a file for a screenshot of the window as its second. It runs an app that lies inside this checkout from a copy in its throwaway folder: from inside the checkout, Node would find a module that the package left out in the checkout's own `node_modules`.

electron-builder packs only the packages that it finds through `dependencies` and `optionalDependencies`. The DSH packages ask for many packages as peers, which npm installs but electron-builder would leave out, so `package.json` lists them as dependencies. `npm test` fails when one is missing and names it.

The Windows installer installs for the current user only, without administrator rights, by default into `%LOCALAPPDATA%\Programs\DeepSeek Bot` (`build/installer.nsh` skips the page that asks for all users or only for the current one). The uninstaller removes the program and keeps the data location and the app's own data. CI builds the Windows installer on every pull request, checks the packaged app, then installs it, checks the installed app and uninstalls it.

## Layout

| File | What it does |
|---|---|
| `src/main.mjs` | Main process: one instance, the `dsh-app://app` scheme (DSH's Web front end, and everything else forwarded to the Host), the window and its boot data |
| `src/preload.cjs` | Hands the window the boot data that DSH's Web front end needs |
| `src/host-process.mjs` | Starts the Host in Electron's Node mode and owns its exit |
| `src/host.mjs` | The Host: boots the profile with `runProfile()` and reports the launch URL and the page injections |
| `src/profile.mjs` | The profile: its name, its bundles, and its creation and update |
| `src/first-run.mjs` | The first start's dialogs: the two folders and the offer to import |
| `src/import.mjs` | The import of a Bot team from the user's DSH |
| `engine/` | On hold, not installed: the bundle `deepseek-bot-engine` for the app's own window in `ui/` |
| `test/` | `npm test`: the composition of the profile, and the dependencies that the package needs |
| `src/web.mjs` | DSH's Web front end document, the launch-token cookie exchange and the request forwarding |
| `ui/` | On hold, not built or packaged: the app's own window. React, built with Vite (`vite.config.js`) into `ui/dist`. It draws the plugin's own Bot views from `../ds-bot/src/client/` (sidebar, chat rows, docks, dialogs and their stylesheets) and puts its own Markdown in place of DSH's. It uses ds-bot's `api/bot` channel and its live feed `api/bot/feed` |
| `assets/` | The app icon: `icon.svg`, `icon.png` (1024 px) and `icon.ico` (Windows, 16 to 256 px). `npm run icon` (`scripts/icon.mjs`) draws them again from the Main Bot's whale in `../ds-bot` |
| `electron-builder.yml`, `build/` | The package and the installer: app identity, files, icons, the Windows installer and the macOS disk image |
| `scripts/check-packed.mjs` | `npm run check-packed`: the check of a packaged app |

The Host installs plugins with the app's own pnpm (`node_modules/pnpm`).

Some files adapt code from DSH Desktop (MIT); see [NOTICE](../NOTICE).
