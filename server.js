// Know Your Numbers — standalone server
//
// Serves the app (public/index.html) and a tiny REST API that the page's
// db shim talks to. Storage is a single SQLite file via Node's built-in
// node:sqlite module, so there's nothing to compile at deploy time.
//
// Data model: one row per "document path" (e.g. "biz-months/2026-09"),
// storing a JSON blob — the same doc()/get()/set()/update() shape the app
// already used against Claude's built-in storage.

const path = require("path");
const fs = require("fs");
const express = require("express");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "app.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

// WAL lets reads proceed while a write is in flight and survives an abrupt
// container stop far better than the default rollback journal — Railway sends
// SIGTERM and moves on, so a half-applied write is a real risk. busy_timeout
// makes a concurrent writer wait for the lock instead of failing immediately.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA synchronous = NORMAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS docs (
    path TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

const getStmt = db.prepare("SELECT data FROM docs WHERE path = ?");
const upsertStmt = db.prepare(`
  INSERT INTO docs (path, data, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);
const deleteStmt = db.prepare("DELETE FROM docs WHERE path = ?");

// Mirrors the even-segment (collection/id pairs) rule the app's original
// storage backend enforced, so a malformed path fails loudly instead of
// silently writing somewhere unexpected.
function validatePath(docPath) {
  const segs = docPath.split("/").filter(Boolean);
  if (segs.length === 0 || segs.length % 2 !== 0) {
    const err = new Error(
      `document paths need an even number of segments (collection/id pairs); "${docPath}" has ${segs.length}`
    );
    err.status = 400;
    throw err;
  }
  return segs.join("/");
}

function readDoc(docPath) {
  const row = getStmt.get(docPath);
  if (!row) return { exists: false, data: null };
  return { exists: true, data: JSON.parse(row.data) };
}

function writeDoc(docPath, value) {
  upsertStmt.run(docPath, JSON.stringify(value), new Date().toISOString());
}

const app = express();
app.use(express.json({ limit: "10mb" }));

// Railway polls this to decide whether a new deploy is healthy enough to
// replace the running one. It touches the database on purpose: a process that
// is listening but can't read its own volume is not actually up.
app.get("/health", (req, res) => {
  try {
    db.prepare("SELECT 1").get();
    res.json({ ok: true, db: DB_PATH });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

const apiRouter = express.Router();

// Whole-database dump, so there is a way to get the data out that doesn't
// involve the Railway volume. Registered before /doc/* so "export" is never
// read as a document path.
apiRouter.get("/export", (req, res, next) => {
  try {
    const rows = db.prepare("SELECT path, data, updated_at FROM docs ORDER BY path").all();
    const docs = {};
    for (const row of rows) docs[row.path] = JSON.parse(row.data);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Disposition", `attachment; filename="know-your-numbers-${stamp}.json"`);
    res.json({ exportedAt: new Date().toISOString(), count: rows.length, docs });
  } catch (e) {
    next(e);
  }
});

apiRouter.get("/doc/*path", (req, res, next) => {
  try {
    const docPath = validatePath(req.params.path.join("/"));
    res.json(readDoc(docPath));
  } catch (e) {
    next(e);
  }
});

apiRouter.put("/doc/*path", (req, res, next) => {
  try {
    const docPath = validatePath(req.params.path.join("/"));
    writeDoc(docPath, req.body ?? {});
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

apiRouter.patch("/doc/*path", (req, res, next) => {
  try {
    const docPath = validatePath(req.params.path.join("/"));
    const existing = readDoc(docPath);
    const merged = Object.assign({}, existing.exists ? existing.data : {}, req.body ?? {});
    writeDoc(docPath, merged);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

apiRouter.delete("/doc/*path", (req, res, next) => {
  try {
    const docPath = validatePath(req.params.path.join("/"));
    deleteStmt.run(docPath);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.use("/api", apiRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal error" });
});

app.use(express.static(path.join(__dirname, "public")));

// Single-page app fallback — anything else that's a GET and wasn't a static
// file or an API route just gets the app shell.
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = app.listen(PORT, () => {
  console.log(`Know Your Numbers running on port ${PORT} (db: ${DB_PATH})`);
});

// Railway sends SIGTERM on every redeploy. Without this the process is killed
// mid-request and the database is closed by the OS rather than by SQLite.
function shutdown(signal) {
  console.log(`${signal} received — finishing in-flight requests, then closing the database.`);
  server.close(() => {
    try {
      db.close();
    } catch (e) {
      console.error("error closing database:", e.message);
    }
    process.exit(0);
  });
  // Don't hang forever on a wedged connection.
  setTimeout(() => {
    console.error("shutdown timed out — exiting anyway");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
