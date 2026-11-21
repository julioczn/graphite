# Contributing to Graphite

Thanks for your interest! Bug reports, ideas, translations and pull requests are all welcome.

## Before you start

- **Bugs and ideas**: open an [issue](https://github.com/julioczn/graphite/issues) first, especially for larger
  changes, so we can agree on the approach before you spend time on it.
- **Security problems**: don't open a public issue; see [SECURITY.md](SECURITY.md).
- Discussions and issues can be in English, Portuguese or Spanish.

## Development setup

Requires **Node.js 22+** and macOS or Linux.

```bash
git clone https://github.com/julioczn/graphite.git
cd graphite
npm install
npm run dev
```

`npm run dev` starts Vite with hot reload and Electron. Use a throwaway profile so you don't touch your real
connections: `GRAPHITE_PROFILE_DIR=/tmp/graphite-dev npm run dev`. The **Open demo** button gives you a SQLite
database to play with.

The `dev`/`start` scripts pass `--no-sandbox` because `node_modules/electron/dist/chrome-sandbox` isn't owned by root
on most Linux setups. Packaged builds run with the sandbox on.

## How the code is organized

- `electron/main.cjs`: windows, native dialogs, secrets (`safeStorage`) and the AI features (`electron/ai/`).
- `electron/utility.cjs`: a separate process that owns every database connection; the window talks to it directly
  over a `MessagePort` (`window.graphite.call('<area>/<action>', args)`).
- `electron/drivers/`: one file per database. New dialect features usually need a change in all three.
- `src/`: the Vue 3 renderer. It is sandboxed: no Node.js, only what `electron/preload.cjs` exposes.
- `shared/`: code used by both sides (SQL statement splitting, translations).

## Guidelines

- Keep changes focused; match the style of the file you're editing (the code base has no formatter config yet).
- Test what you change against the databases it affects. A quick way to get servers:
  `docker run --rm -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres` and
  `docker run --rm -e MYSQL_ROOT_PASSWORD=pw -p 3306:3306 mysql`.
- **All user-facing text goes through `t()`** with the Portuguese text as the key, and needs English and Spanish
  entries in `shared/locales/`. Run `npm run i18n:check` (also with `--suspects` to find untranslated text).
- Anything that lets AI agents touch a database must keep the guarantees described in the README: reads enforced
  read-only by the database, writes only after the user approves them.
- Before opening a PR, run `npm run build` and `npm run i18n:check`, and try the app (`npm start`).
- Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) for user-visible changes.

## Translations

Native speakers are very welcome to review `shared/locales/en.mjs` and `shared/locales/es.mjs`, or to add a new
language: copy `en.mjs`, translate the values (keep `{placeholders}` and the `one|other` plural form), and register it
in `shared/i18n.mjs`.

## Releases

Maintainers bump the version in `package.json`, update the changelog and push a `vX.Y.Z` tag; the
[release workflow](.github/workflows/release.yml) builds the macOS and Linux packages and attaches them to a draft
GitHub release.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
