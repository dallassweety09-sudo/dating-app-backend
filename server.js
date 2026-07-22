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

CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_id INTEGER NOT NULL,
  blocked_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL,
  reported_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  details TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS coin_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
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
  "latitude REAL",
  "longitude REAL",
  "invisible INTEGER DEFAULT 0",
  "coins INTEGER DEFAULT 20",
  "boosted_until TEXT DEFAULT ''",
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

function distanceKm(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
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
    latitude, longitude, invisible,
  } = req.body || {};
  const age = birthdate ? calculateAge(birthdate) : null;
  const primaryImg = photos && photos.length ? photos[0] : img;
  db.prepare(
    `UPDATE users SET name = COALESCE(?, name), genre = COALESCE(?, genre),
     genre_recherche = COALESCE(?, genre_recherche), city = COALESCE(?, city),
     bio = COALESCE(?, bio), img = COALESCE(?, img), intention = COALESCE(?, intention),
     birthdate = COALESCE(?, birthdate), age = COALESCE(?, age), profession = COALESCE(?, profession),
     taille = COALESCE(?, taille), photos = COALESCE(?, photos),
     interests = COALESCE(?, interests), langues = COALESCE(?, langues),
     latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude),
     invisible = COALESCE(?, invisible)
     WHERE id = ?`
  ).run(
    name, genre, genre_recherche, city, bio, primaryImg, intention, birthdate, age, profession, taille,
    photos ? JSON.stringify(photos) : null,
    interests ? JSON.stringify(interests) : null,
    langues ? JSON.stringify(langues) : null,
    latitude ?? null, longitude ?? null,
    invisible === undefined ? null : (invisible ? 1 : 0),
    req.userId
  );
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
  res.json({ user: publicUser(user) });
});

// ---------- Discover (avec filtres) ----------
app.get("/api/discover", authMiddleware, (req, res) => {
  const {
    genre = "Tous", ageMin = 18, ageMax = 99, intention = "",
    verifiedOnly = "false", langue = "", tailleMin = "", tailleMax = "", commonInterests = "false",
    maxDistance = "",
  } = req.query;

  const alreadySwiped = db
    .prepare("SELECT to_user_id FROM swipes WHERE from_user_id = ?")
    .all(req.userId)
    .map((r) => r.to_user_id);

  const blockedByMe = db.prepare("SELECT blocked_id FROM blocks WHERE blocker_id = ?").all(req.userId).map((r) => r.blocked_id);
  const blockedMe = db.prepare("SELECT blocker_id FROM blocks WHERE blocked_id = ?").all(req.userId).map((r) => r.blocker_id);

  const exclude = [req.userId, ...alreadySwiped, ...blockedByMe, ...blockedMe];
  const placeholders = exclude.map(() => "?").join(",");

  let query = `SELECT id, name, age, genre, city, bio, img, intention, profession, taille, photos, interests, langues,
      verification_status, latitude, longitude, boosted_until FROM users
    WHERE id NOT IN (${placeholders}) AND age >= ? AND age <= ? AND (invisible IS NULL OR invisible = 0)`;
  const params = [...exclude, Number(ageMin), Number(ageMax)];

  if (genre !== "Tous") {
    query += " AND genre = ?";
    params.push(genre);
  }
  if (intention && intention !== "Toutes") {
    query += " AND intention = ?";
    params.push(intention);
  }
  if (verifiedOnly === "true") {
    query += " AND verification_status = 'verified'";
  }
  if (tailleMin) {
    query += " AND taille >= ?";
    params.push(Number(tailleMin));
  }
  if (tailleMax) {
    query += " AND taille <= ?";
    params.push(Number(tailleMax));
  }

  const me = db.prepare("SELECT latitude, longitude, interests FROM users WHERE id = ?").get(req.userId);

  let profiles = db.prepare(query).all(...params).map((p) => {
    const dist = distanceKm(me?.latitude, me?.longitude, p.latitude, p.longitude);
    return {
      ...p,
      photos: safeParseArray(p.photos),
      interests: safeParseArray(p.interests),
      langues: safeParseArray(p.langues),
      distance_km: dist == null ? null : Math.round(dist * 10) / 10,
      is_boosted: !!(p.boosted_until && new Date(p.boosted_until + "Z") > new Date()),
      latitude: undefined,
      longitude: undefined,
      boosted_until: undefined,
    };
  });

  // Filtre langue : correspondance insensible à la casse sur la liste de langues parlées.
  if (langue) {
    const needle = langue.trim().toLowerCase();
    profiles = profiles.filter((p) => p.langues.some((l) => l.toLowerCase().includes(needle)));
  }

  // Filtre centres d'intérêt communs : compare avec les centres d'intérêt de l'utilisateur connecté.
  if (commonInterests === "true") {
    const myInterests = safeParseArray(me?.interests).map((i) => i.toLowerCase());
    if (myInterests.length > 0) {
      profiles = profiles.filter((p) => p.interests.some((i) => myInterests.includes(i.toLowerCase())));
    }
  }

  // Filtre distance max (uniquement appliqué si on connaît la distance réelle du profil).
  if (maxDistance) {
    const max = Number(maxDistance);
    profiles = profiles.filter((p) => p.distance_km == null || p.distance_km <= max);
  }

  // Les profils boostés remontent en premier, puis on trie par proximité quand elle est connue.
  profiles.sort((a, b) => {
    if (a.is_boosted !== b.is_boosted) return a.is_boosted ? -1 : 1;
    if (a.distance_km == null && b.distance_km == null) return 0;
    if (a.distance_km == null) return 1;
    if (b.distance_km == null) return -1;
    return a.distance_km - b.distance_km;
  });

  res.json({ profiles });
});

// ---------- Swipe + détection de match ----------
const SUPERLIKE_COST = 10;
const BOOST_COST = 50;
const BOOST_DURATION_MIN = 30;

app.post("/api/swipe", authMiddleware, (req, res) => {
  const { toUserId, action } = req.body || {};
  if (!toUserId || !["like", "pass", "superlike"].includes(action)) {
    return res.status(400).json({ error: "Paramètres invalides." });
  }

  const user = db.prepare("SELECT genre, plan, coins FROM users WHERE id = ?").get(req.userId);
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

  if (action === "superlike") {
    if ((user?.coins || 0) < SUPERLIKE_COST) {
      return res.status(402).json({ error: "Pas assez de Lovinia Coins pour un Super Like.", code: "INSUFFICIENT_COINS", cost: SUPERLIKE_COST });
    }
    db.prepare("UPDATE users SET coins = coins - ? WHERE id = ?").run(SUPERLIKE_COST, req.userId);
    db.prepare("INSERT INTO coin_transactions (user_id, amount, reason) VALUES (?, ?, ?)").run(req.userId, -SUPERLIKE_COST, "Super Like envoyé");
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

app.post("/api/swipe/undo", authMiddleware, (req, res) => {
  const last = db
    .prepare("SELECT * FROM swipes WHERE from_user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(req.userId);
  if (!last) return res.status(404).json({ error: "Rien à annuler." });

  // Si ce swipe avait déjà créé un match, on le retire aussi (avec ses messages).
  const [a, b] = [req.userId, last.to_user_id].sort((x, y) => x - y);
  const match = db.prepare("SELECT id FROM matches WHERE user_a_id = ? AND user_b_id = ?").get(a, b);
  if (match) {
    db.prepare("DELETE FROM messages WHERE match_id = ?").run(match.id);
    db.prepare("DELETE FROM matches WHERE id = ?").run(match.id);
  }

  db.prepare("DELETE FROM swipes WHERE id = ?").run(last.id);

  const profile = db
    .prepare("SELECT id, name, age, genre, city, bio, img, intention, profession, taille, photos, interests, langues, verification_status FROM users WHERE id = ?")
    .get(last.to_user_id);
  if (profile) profile.photos = safeParseArray(profile.photos), profile.interests = safeParseArray(profile.interests), profile.langues = safeParseArray(profile.langues);

  res.json({ restored: profile || null });
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

// ---------- Blocage & signalement ----------
app.post("/api/block/:userId", authMiddleware, (req, res) => {
  const targetId = Number(req.params.userId);
  if (targetId === req.userId) return res.status(400).json({ error: "Action impossible." });

  db.prepare("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)").run(req.userId, targetId);

  // On retire aussi tout match et messages existants entre les deux personnes.
  const match = db
    .prepare("SELECT id FROM matches WHERE (user_a_id = ? AND user_b_id = ?) OR (user_a_id = ? AND user_b_id = ?)")
    .get(req.userId, targetId, targetId, req.userId);
  if (match) {
    db.prepare("DELETE FROM messages WHERE match_id = ?").run(match.id);
    db.prepare("DELETE FROM matches WHERE id = ?").run(match.id);
  }

  res.json({ blocked: true });
});

app.delete("/api/block/:userId", authMiddleware, (req, res) => {
  db.prepare("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?").run(req.userId, Number(req.params.userId));
  res.json({ blocked: false });
});

app.get("/api/blocked", authMiddleware, (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.img FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ?`
    )
    .all(req.userId);
  res.json({ blocked: rows });
});

app.post("/api/report", authMiddleware, (req, res) => {
  const { reportedId, reason, details } = req.body || {};
  if (!reportedId || !reason) return res.status(400).json({ error: "Motif de signalement requis." });
  db.prepare(
    "INSERT INTO reports (reporter_id, reported_id, reason, details) VALUES (?, ?, ?, ?)"
  ).run(req.userId, Number(reportedId), reason, details || "");
  res.json({ reported: true });
});

app.get("/api/admin/reports", adminMiddleware, (req, res) => {
  const rows = db
    .prepare(
      `SELECT r.*, ru.name as reporter_name, tu.name as reported_name, tu.email as reported_email
       FROM reports r
       JOIN users ru ON ru.id = r.reporter_id
       JOIN users tu ON tu.id = r.reported_id
       WHERE r.status = 'pending'
       ORDER BY r.created_at DESC`
    )
    .all();
  res.json({ reports: rows });
});

app.post("/api/admin/reports/:reportId/resolve", adminMiddleware, (req, res) => {
  db.prepare("UPDATE reports SET status = 'resolved' WHERE id = ?").run(req.params.reportId);
  res.json({ ok: true });
});

// ---------- Visiteurs du profil ----------
app.get("/api/visitors", authMiddleware, (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.age, u.img, MAX(s.created_at) as visited_at
       FROM swipes s JOIN users u ON u.id = s.from_user_id
       WHERE s.to_user_id = ?
       GROUP BY u.id
       ORDER BY visited_at DESC
       LIMIT 50`
    )
    .all(req.userId);
  res.json({ visitors: rows });
});

// ---------- Lovinia Coins ----------
app.get("/api/me/coins", authMiddleware, (req, res) => {
  const row = db.prepare("SELECT coins FROM users WHERE id = ?").get(req.userId);
  res.json({ coins: row?.coins || 0 });
});

app.post("/api/boost", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT coins FROM users WHERE id = ?").get(req.userId);
  if ((user?.coins || 0) < BOOST_COST) {
    return res.status(402).json({ error: "Pas assez de Lovinia Coins pour un boost.", code: "INSUFFICIENT_COINS", cost: BOOST_COST });
  }
  const until = new Date(Date.now() + BOOST_DURATION_MIN * 60000).toISOString().slice(0, 19).replace("T", " ");
  db.prepare("UPDATE users SET coins = coins - ?, boosted_until = ? WHERE id = ?").run(BOOST_COST, until, req.userId);
  db.prepare("INSERT INTO coin_transactions (user_id, amount, reason) VALUES (?, ?, ?)").run(req.userId, -BOOST_COST, "Boost de profil");
  res.json({ boostedUntil: until });
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
