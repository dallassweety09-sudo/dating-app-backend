require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
// DB_PATH : en local, un simple fichier suffit. En production sur Railway, cette variable
// doit pointer vers un dossier monté sur un Volume permanent (ex: /data/dating_app.db),
// sinon la base repart de zéro à chaque nouveau déploiement.
const DB_PATH = process.env.DB_PATH || "dating_app.db";

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// ---------- Schéma ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  age INTEGER DEFAULT 18,
  birthdate TEXT DEFAULT '',
  genre TEXT DEFAULT 'Non précisé',
  genre_recherche TEXT DEFAULT 'Tous',
  city TEXT DEFAULT '',
  profession TEXT DEFAULT '',
  taille INTEGER,
  bio TEXT DEFAULT '',
  img TEXT DEFAULT '',
  photos TEXT DEFAULT '[]',
  interests TEXT DEFAULT '[]',
  langues TEXT DEFAULT '[]',
  intention TEXT DEFAULT '',
  verification_status TEXT DEFAULT 'none',
  verification_selfie TEXT DEFAULT '',
  plan TEXT DEFAULT 'free',
  plan_expires_at TEXT DEFAULT '',
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
  is_read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// Migration douce : si la base existait déjà avant l'ajout de ces colonnes,
// on les ajoute maintenant sans effacer aucune donnée existante.
const newColumns = [
  "birthdate TEXT DEFAULT ''",
  "genre_recherche TEXT DEFAULT 'Tous'",
  "profession TEXT DEFAULT ''",
  "taille INTEGER",
  "photos TEXT DEFAULT '[]'",
  "interests TEXT DEFAULT '[]'",
  "langues TEXT DEFAULT '[]'",
  "intention TEXT DEFAULT ''",
  "verification_status TEXT DEFAULT 'none'",
  "verification_selfie TEXT DEFAULT ''",
  "plan TEXT DEFAULT 'free'",
  "plan_expires_at TEXT DEFAULT ''",
];
for (const col of newColumns) {
  try {
    db.exec(`ALTER TABLE users ADD COLUMN ${col}`);
  } catch (e) {
    // La colonne existe déjà : rien à faire, c'est normal après le premier déploiement.
  }
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN is_read INTEGER DEFAULT 0`);
} catch (e) {
  // Déjà présente, rien à faire.
}

function calculateAge(birthdate) {
  if (!birthdate) return null;
  const dob = new Date(birthdate);
  if (isNaN(dob.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}

function dailyLikeLimit(genre) {
  if (genre === "Femme") return 40;
  return 20; // Homme et autres cas
}

function countTodayLikes(userId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM swipes
       WHERE from_user_id = ? AND action IN ('like','superlike') AND date(created_at) = date('now')`
    )
    .get(userId);
  return row.n;
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

function adminMiddleware(req, res, next) {
  const key = req.headers["x-admin-key"] || "";
  if (!ADMIN_SECRET || key !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Accès administrateur refusé." });
  }
  next();
}

function publicUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return {
    ...rest,
    photos: safeParseArray(u.photos),
    interests: safeParseArray(u.interests),
    langues: safeParseArray(u.langues),
  };
}

function safeParseArray(str) {
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ---------- Auth routes ----------
app.post("/api/auth/register", async (req, res) => {
  const {
    name, email, password, intention,
    birthdate, genre, genre_recherche, city, profession, taille,
    bio, photos, interests, langues,
  } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Nom, email et mot de passe sont requis." });
  }
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "Un compte existe déjà avec cet email." });

  const hash = await bcrypt.hash(password, 10);
  const age = calculateAge(birthdate);
  const photosArr = Array.isArray(photos) ? photos : [];
  const info = db
    .prepare(
      `INSERT INTO users (name, email, password_hash, intention, birthdate, age, genre, genre_recherche,
        city, profession, taille, bio, img, photos, interests, langues)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name, email, hash, intention || "", birthdate || "", age || 18,
      genre || "Non précisé", genre_recherche || "Tous", city || "",
      profession || "", taille || null, bio || "", photosArr[0] || "",
      JSON.stringify(photosArr), JSON.stringify(interests || []), JSON.stringify(langues || [])
    );
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

app.post("/api/auth/google", async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: "Jeton Google manquant." });
  if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: "Connexion Google non configurée côté serveur." });

  let payload;
  try {
    const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    if (!verifyRes.ok) throw new Error("invalid");
    payload = await verifyRes.json();
  } catch {
    return res.status(401).json({ error: "Jeton Google invalide." });
  }

  if (payload.aud !== GOOGLE_CLIENT_ID) {
    return res.status(401).json({ error: "Jeton Google non destiné à cette application." });
  }
  if (payload.email_verified !== "true" && payload.email_verified !== true) {
    return res.status(401).json({ error: "Email Google non vérifié." });
  }

  const email = payload.email;
  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

  if (!user) {
    const randomPassword = crypto.randomBytes(24).toString("hex");
    const hash = await bcrypt.hash(randomPassword, 10);
    const info = db
      .prepare("INSERT INTO users (name, email, password_hash, img) VALUES (?, ?, ?, ?)")
      .run(payload.name || email.split("@")[0], email, hash, payload.picture || "");
    user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
  }

  const publicU = publicUser(user);
  const needsProfileCompletion = !user.birthdate || !user.intention || publicU.photos.length < 2;
  res.json({ token: signToken(user), user: publicU, needsProfileCompletion });
});

// ---------- Profile ----------
app.get("/api/me", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
  res.json({ user: publicUser(user) });
});

app.put("/api/me", authMiddleware, (req, res) => {
  const {
    name, genre, genre_recherche, city, bio, img, intention,
    birthdate, profession, taille, photos, interests, langues,
  } = req.body || {};
  const age = birthdate ? calculateAge(birthdate) : null;
  const primaryImg = photos && photos.length ? photos[0] : img;
  db.prepare(
    `UPDATE users SET name = COALESCE(?, name), genre = COALESCE(?, genre),
     genre_recherche = COALESCE(?, genre_recherche), city = COALESCE(?, city),
     bio = COALESCE(?, bio), img = COALESCE(?, img), intention = COALESCE(?, intention),
     birthdate = COALESCE(?, birthdate), age = COALESCE(?, age), profession = COALESCE(?, profession),
     taille = COALESCE(?, taille), photos = COALESCE(?, photos),
     interests = COALESCE(?, interests), langues = COALESCE(?, langues)
     WHERE id = ?`
  ).run(
    name, genre, genre_recherche, city, bio, primaryImg, intention, birthdate, age, profession, taille,
    photos ? JSON.stringify(photos) : null,
    interests ? JSON.stringify(interests) : null,
    langues ? JSON.stringify(langues) : null,
    req.userId
  );
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

  let query = `SELECT id, name, age, genre, city, bio, img, intention, profession, taille, photos, interests, langues, verification_status FROM users
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

  const profiles = db.prepare(query).all(...params).map((p) => ({
    ...p,
    photos: safeParseArray(p.photos),
    interests: safeParseArray(p.interests),
    langues: safeParseArray(p.langues),
  }));
  res.json({ profiles });
});

// ---------- Swipe + détection de match ----------
app.post("/api/swipe", authMiddleware, (req, res) => {
  const { toUserId, action } = req.body || {};
  if (!toUserId || !["like", "pass", "superlike"].includes(action)) {
    return res.status(400).json({ error: "Paramètres invalides." });
  }

  const user = db.prepare("SELECT genre, plan FROM users WHERE id = ?").get(req.userId);
  const isPremium = user?.plan && user.plan !== "free";

  if ((action === "like" || action === "superlike") && !isPremium) {
    const limit = dailyLikeLimit(user?.genre);
    const used = countTodayLikes(req.userId);
    if (used >= limit) {
      return res.status(403).json({
        error: "Limite quotidienne de likes atteinte.",
        code: "LIKE_LIMIT_REACHED",
        limit,
        used,
      });
    }
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
      `SELECT m.id as match_id, u.id, u.name, u.age, u.city, u.img,
         (SELECT text FROM messages WHERE match_id = m.id ORDER BY created_at DESC LIMIT 1) as last_message,
         (SELECT created_at FROM messages WHERE match_id = m.id ORDER BY created_at DESC LIMIT 1) as last_message_at,
         (SELECT COUNT(*) FROM messages WHERE match_id = m.id AND sender_id != ? AND is_read = 0) as unread_count
       FROM matches m
       JOIN users u ON u.id = CASE WHEN m.user_a_id = ? THEN m.user_b_id ELSE m.user_a_id END
       WHERE m.user_a_id = ? OR m.user_b_id = ?
       ORDER BY COALESCE(last_message_at, m.created_at) DESC`
    )
    .all(req.userId, req.userId, req.userId, req.userId);
  res.json({ matches: rows });
});

app.get("/api/notifications/summary", authMiddleware, (req, res) => {
  const row = db
    .prepare(
      `SELECT COUNT(*) as unread FROM messages msg
       JOIN matches m ON m.id = msg.match_id
       WHERE (m.user_a_id = ? OR m.user_b_id = ?) AND msg.sender_id != ? AND msg.is_read = 0`
    )
    .get(req.userId, req.userId, req.userId);
  res.json({ unreadMessages: row.unread });
});

// ---------- Messages ----------
app.get("/api/matches/:matchId/messages", authMiddleware, (req, res) => {
  const messages = db
    .prepare("SELECT * FROM messages WHERE match_id = ? ORDER BY created_at ASC")
    .all(req.params.matchId);
  // On marque comme lus tous les messages de l'autre personne dès qu'on ouvre la conversation.
  db.prepare("UPDATE messages SET is_read = 1 WHERE match_id = ? AND sender_id != ?").run(req.params.matchId, req.userId);
  res.json({ messages });
});

app.post("/api/matches/:matchId/messages", authMiddleware, (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Message vide." });
  const info = db
    .prepare("INSERT INTO messages (match_id, sender_id, text, is_read) VALUES (?, ?, ?, 0)")
    .run(req.params.matchId, req.userId, text.trim());
  const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(info.lastInsertRowid);
  res.json({ message });
});

app.get("/api/me/limits", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT genre, plan FROM users WHERE id = ?").get(req.userId);
  const isPremium = user?.plan && user.plan !== "free";
  const limit = dailyLikeLimit(user?.genre);
  const used = countTodayLikes(req.userId);
  res.json({
    plan: user?.plan || "free",
    unlimited: !!isPremium,
    limit,
    used,
    remaining: isPremium ? null : Math.max(0, limit - used),
  });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

// ---------- Vérification d'identité (badge) ----------
app.post("/api/verification/submit", authMiddleware, (req, res) => {
  const { selfieUrl } = req.body || {};
  if (!selfieUrl) return res.status(400).json({ error: "Photo selfie manquante." });
  db.prepare(
    "UPDATE users SET verification_status = 'pending', verification_selfie = ? WHERE id = ?"
  ).run(selfieUrl, req.userId);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
  res.json({ user: publicUser(user) });
});

app.get("/api/admin/verifications", adminMiddleware, (req, res) => {
  const pending = db
    .prepare("SELECT id, name, email, img, photos, verification_selfie, verification_status FROM users WHERE verification_status = 'pending'")
    .all()
    .map((u) => ({ ...u, photos: safeParseArray(u.photos) }));
  res.json({ pending });
});

app.post("/api/admin/verifications/:userId/decision", adminMiddleware, (req, res) => {
  const { approve } = req.body || {};
  const status = approve ? "verified" : "rejected";
  db.prepare("UPDATE users SET verification_status = ? WHERE id = ?").run(status, req.params.userId);
  res.json({ status });
});

app.delete("/api/me", authMiddleware, async (req, res) => {
  const { password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
  if (!user) return res.status(404).json({ error: "Compte introuvable." });

  if (password) {
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Mot de passe incorrect." });
  }

  const matchIds = db
    .prepare("SELECT id FROM matches WHERE user_a_id = ? OR user_b_id = ?")
    .all(req.userId, req.userId)
    .map((m) => m.id);

  const deleteAll = db.transaction(() => {
    for (const matchId of matchIds) {
      db.prepare("DELETE FROM messages WHERE match_id = ?").run(matchId);
    }
    db.prepare("DELETE FROM matches WHERE user_a_id = ? OR user_b_id = ?").run(req.userId, req.userId);
    db.prepare("DELETE FROM swipes WHERE from_user_id = ? OR to_user_id = ?").run(req.userId, req.userId);
    db.prepare("DELETE FROM users WHERE id = ?").run(req.userId);
  });
  deleteAll();

  res.json({ deleted: true });
});

app.listen(PORT, () => {
  console.log(`API de l'appli de rencontre lancée sur http://localhost:${PORT}`);
});
