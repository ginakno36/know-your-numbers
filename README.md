# Know Your Numbers

Business + personal finance dashboard. This is a standalone version of the
app — a small Node server that serves the page and stores your data in its
own SQLite database, instead of Claude's built-in storage.

## Layout

```
server.js           the Node server: serves the page + a small REST API
public/index.html   the whole app (self-contained HTML/CSS/JS)
data/app.db         your data (created automatically, ignored by git)
```

`server.js` serves everything in `public/`, so the page must live at
`public/index.html` — not at the repo root.

## Running it locally

```
npm install
npm start
```

Then open http://localhost:3000. Needs **Node 24 or newer** (the server uses
the built-in `node:sqlite` module, so there's nothing to compile).

## Deploying to Railway

The app deploys as-is — Railway detects Node, runs `npm install`, then
`npm start`, and provides the port via `$PORT`.

1. **New Project → Deploy from GitHub repo**, and pick this repository.
   (Railway will ask for access to your GitHub account the first time.)
2. **Add a volume.** In the service, go to *Variables → + Volume* and mount
   it at `/data`.
3. **Set the database path.** Add the environment variable:

   ```
   DB_PATH=/data/app.db
   ```

4. **Generate a domain** under *Settings → Networking → Generate Domain*.

### Do steps 2 and 3 before entering real data

Without the volume, `data/app.db` lives on the container's temporary disk,
and **every redeploy starts from an empty database**. Setting `DB_PATH` to a
path inside the mounted volume is what makes the data survive redeploys.

To confirm it worked: enter something, redeploy the service, and reload the
page. If your data is still there, the volume is wired up correctly.

## Backing up the data

The whole database is downloadable as one JSON file:

```
https://<your-app-url>/api/export
```

The Railway volume is the only copy of the data, so download this
periodically — a deleted volume or a mistaken redeploy has no undo.

## Health check

`GET /health` returns `{"ok":true}` and actually queries the database, so a
process that is listening but can't read its volume reports unhealthy rather
than silently serving a broken app. Railway is configured to poll it
(`railway.json`), and won't swap a new deploy in until it passes.

## No password protection



By request, this deployment has no login — anyone with the URL can open and
edit the data. Treat the Railway URL itself as the thing to keep private. If
you ever want a simple password gate added later, that's a small change.
