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

const apiRouter = express.Router();

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

app.listen(PORT, () => {
  console.log(`Know Your Numbers running on port ${PORT} (db: ${DB_PATH})`);
});
