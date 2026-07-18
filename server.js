require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

const db = new Database("dating_app.db");
db.pragma("journal_mode = WAL");

// ---------- Schéma ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  age INTEGER DEFAULT 18,
  genre TEXT DEFAULT 'Non précisé',
  city TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  img TEXT DEFAULT '',
  intention TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS swipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER NOT NULL,
  to_user_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('like','pass','superlike')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(from_user_id, to_user_id)
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a_id INTEGER NOT NULL,
  user_b_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_a_id, user_b_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// Migration douce : si la base existait déjà avant l'ajout de la colonne "intention",
// on l'ajoute maintenant sans effacer aucune donnée existante.
try {
  db.exec(`ALTER TABLE users ADD COLUMN intention TEXT DEFAULT ''`);
} catch (e) {
  // La colonne existe déjà : rien à faire, c'est normal après le premier déploiement.
}

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Auth helpers ----------
function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "30d" });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Non authentifié." });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.id;
    next();
  } catch {
    return res.status(401).json({ error: "Session invalide, reconnecte-toi." });
  }
}

function publicUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return rest;
}

// ---------- Auth routes ----------
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password, intention } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Nom, email et mot de passe sont requis." });
  }
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "Un compte existe déjà avec cet email." });

  const hash = await bcrypt.hash(password, 10);
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash, intention) VALUES (?, ?, ?, ?)")
    .run(name, email, hash, intention || "");
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) return res.status(401).json({ error: "Email ou mot de passe incorrect." });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Email ou mot de passe incorrect." });
  res.json({ token: signToken(user), user: publicUser(user) });
});

// ---------- Profile ----------
app.get("/api/me", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
  res.json({ user: publicUser(user) });
});

app.put("/api/me", authMiddleware, (req, res) => {
  const { name, age, genre, city, bio, img, intention } = req.body || {};
  db.prepare(
    `UPDATE users SET name = COALESCE(?, name), age = COALESCE(?, age), genre = COALESCE(?, genre),
     city = COALESCE(?, city), bio = COALESCE(?, bio), img = COALESCE(?, img),
     intention = COALESCE(?, intention) WHERE id = ?`
  ).run(name, age, genre, city, bio, img, intention, req.userId);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
  res.json({ user: publicUser(user) });
});

// ---------- Discover (avec filtres) ----------
app.get("/api/discover", authMiddleware, (req, res) => {
  const { genre = "Tous", ageMin = 18, ageMax = 99, intention = "" } = req.query;

  const alreadySwiped = db
    .prepare("SELECT to_user_id FROM swipes WHERE from_user_id = ?")
    .all(req.userId)
    .map((r) => r.to_user_id);

  const exclude = [req.userId, ...alreadySwiped];
  const placeholders = exclude.map(() => "?").join(",");

  let query = `SELECT id, name, age, genre, city, bio, img, intention FROM users
    WHERE id NOT IN (${placeholders}) AND age >= ? AND age <= ?`;
  const params = [...exclude, Number(ageMin), Number(ageMax)];

  if (genre !== "Tous") {
    query += " AND genre = ?";
    params.push(genre);
  }
  if (intention && intention !== "Toutes") {
    query += " AND intention = ?";
    params.push(intention);
  }

  const profiles = db.prepare(query).all(...params);
  res.json({ profiles });
});

// ---------- Swipe + détection de match ----------
app.post("/api/swipe", authMiddleware, (req, res) => {
  const { toUserId, action } = req.body || {};
  if (!toUserId || !["like", "pass", "superlike"].includes(action)) {
    return res.status(400).json({ error: "Paramètres invalides." });
  }

  db.prepare(
    `INSERT INTO swipes (from_user_id, to_user_id, action) VALUES (?, ?, ?)
     ON CONFLICT(from_user_id, to_user_id) DO UPDATE SET action = excluded.action`
  ).run(req.userId, toUserId, action);

  let matched = false;
  if (action === "like" || action === "superlike") {
    const reciprocal = db
      .prepare("SELECT * FROM swipes WHERE from_user_id = ? AND to_user_id = ? AND action IN ('like','superlike')")
      .get(toUserId, req.userId);

    if (reciprocal) {
      const [a, b] = [req.userId, toUserId].sort((x, y) => x - y);
      db.prepare("INSERT OR IGNORE INTO matches (user_a_id, user_b_id) VALUES (?, ?)").run(a, b);
      matched = true;
    }
  }

  res.json({ matched });
});

// ---------- Matchs ----------
app.get("/api/matches", authMiddleware, (req, res) => {
  const rows = db
    .prepare(
      `SELECT m.id as match_id, u.id, u.name, u.age, u.city, u.img
       FROM matches m
       JOIN users u ON u.id = CASE WHEN m.user_a_id = ? THEN m.user_b_id ELSE m.user_a_id END
       WHERE m.user_a_id = ? OR m.user_b_id = ?`
    )
    .all(req.userId, req.userId, req.userId);
  res.json({ matches: rows });
});

// ---------- Messages ----------
app.get("/api/matches/:matchId/messages", authMiddleware, (req, res) => {
  const messages = db
    .prepare("SELECT * FROM messages WHERE match_id = ? ORDER BY created_at ASC")
    .all(req.params.matchId);
  res.json({ messages });
});

app.post("/api/matches/:matchId/messages", authMiddleware, (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Message vide." });
  const info = db
    .prepare("INSERT INTO messages (match_id, sender_id, text) VALUES (?, ?, ?)")
    .run(req.params.matchId, req.userId, text.trim());
  const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(info.lastInsertRowid);
  res.json({ message });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`API de l'appli de rencontre lancée sur http://localhost:${PORT}`);
});
