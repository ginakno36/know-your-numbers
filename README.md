# Know Your Numbers

Business + personal finance dashboard. This is a standalone version of the
app — a small Node server that serves the page and stores your data in its
own SQLite database, instead of Claude's built-in storage.

## Running it locally

```
npm install
npm start
```

Then open http://localhost:3000. Data is stored in `data/app.db` (created
automatically, and ignored by git).

## Deploying

This app deploys as-is to Railway (or any host that runs a Node server):

- `npm start` boots the server on the port Railway provides via `$PORT`.
- It needs a **persistent volume** mounted so `data/app.db` survives
  redeploys — without one, every redeploy would start with an empty
  database. Set the environment variable `DB_PATH` to a path inside that
  volume (e.g. `/data/app.db`) so the app writes there instead of the
  default `data/app.db` next to the code.

## No password protection

By request, this deployment has no login — anyone with the URL can open and
edit the data. Treat the Railway URL itself as the thing to keep private. If
you ever want a simple password gate added later, that's a small change.
