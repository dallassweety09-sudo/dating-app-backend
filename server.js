require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const https = require("https");
const webpush = require("web-push");

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:contact@lovinia.fr";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}
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

CREATE TABLE IF NOT EXISTS private_album_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  requester_id INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id, requester_id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS coin_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  media_url TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'photo',
  caption TEXT DEFAULT '',
  comments_enabled INTEGER DEFAULT 1,
  comments_permission TEXT DEFAULT 'everyone',
  moderation_status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS post_likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(post_id, user_id)
);

CREATE TABLE IF NOT EXISTS post_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gift_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  icon TEXT NOT NULL,
  price_coins INTEGER NOT NULL,
  active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS gifts_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  gift_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS platform_revenue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount INTEGER NOT NULL,
  source TEXT NOT NULL,
  reference_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS post_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  viewer_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(post_id, viewer_id)
);

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount_coins INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT
);
`);

// Cadeaux par défaut, créés une seule fois si la boutique est vide.
if (db.prepare("SELECT COUNT(*) c FROM gift_catalog").get().c === 0) {
  const seedGifts = db.prepare("INSERT INTO gift_catalog (name, icon, price_coins, active, sort_order) VALUES (?, ?, ?, 1, ?)");
  seedGifts.run("Rose", "🌹", 20, 1);
  seedGifts.run("Cœur", "❤️", 50, 2);
  seedGifts.run("Diamant", "💎", 150, 3);
  seedGifts.run("Couronne", "👑", 300, 4);
}

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
  "hide_exact_distance INTEGER DEFAULT 0",
  "blocked_locations TEXT DEFAULT '[]'",
  "travel_city TEXT DEFAULT ''",
  "travel_lat REAL",
  "travel_lng REAL",
  "private_photos TEXT DEFAULT '[]'",
  "suspended INTEGER DEFAULT 0",
  "travel_active INTEGER DEFAULT 0",
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
try {
  db.exec(`ALTER TABLE users ADD COLUMN last_active_at TEXT`);
} catch (e) {
  // Déjà présente, rien à faire.
}
try {
  db.exec(`ALTER TABLE posts ADD COLUMN moderation_status TEXT DEFAULT 'pending'`);
  // Les publications déjà en ligne avant cette mise à jour restent visibles (approuvées rétroactivement).
  db.exec(`UPDATE posts SET moderation_status = 'approved' WHERE moderation_status = 'pending'`);
} catch (e) {
  // Colonne déjà présente, rien à faire.
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN accept_gifts INTEGER DEFAULT 1`);
  db.exec(`ALTER TABLE users ADD COLUMN gift_senders_restriction TEXT DEFAULT 'everyone'`);
  db.exec(`ALTER TABLE users ADD COLUMN hide_gift_count INTEGER DEFAULT 0`);
} catch (e) {
  // Déjà présentes, rien à faire.
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN orientation TEXT`);
  db.exec(`ALTER TABLE users ADD COLUMN creator_balance INTEGER DEFAULT 0`);
} catch (e) {
  // Déjà présentes, rien à faire.
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN phone TEXT`);
  db.exec(`ALTER TABLE users ADD COLUMN wants_marriage TEXT`);
  db.exec(`ALTER TABLE users ADD COLUMN wants_children TEXT`);
  db.exec(`ALTER TABLE users ADD COLUMN education_level TEXT`);
  db.exec(`ALTER TABLE users ADD COLUMN has_pets TEXT`);
  db.exec(`ALTER TABLE users ADD COLUMN drinks_alcohol TEXT`);
  db.exec(`ALTER TABLE users ADD COLUMN smokes TEXT`);
  db.exec(`ALTER TABLE users ADD COLUMN does_sport TEXT`);
} catch (e) {
  // Déjà présentes, rien à faire.
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN religion TEXT`);
  db.exec(`ALTER TABLE users ADD COLUMN astro_sign TEXT`);
} catch (e) {
  // Déjà présentes, rien à faire.
}
try {
  db.exec(`ALTER TABLE posts ADD COLUMN is_private INTEGER DEFAULT 0`);
} catch (e) {
  // Déjà présente, rien à faire.
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0`);
  db.exec(`ALTER TABLE users ADD COLUMN email_verify_token TEXT`);
  db.exec(`ALTER TABLE users ADD COLUMN terms_accepted_at TEXT`);
  // Les comptes déjà existants avant cette mise à jour sont "graciés" : on ne les bloque pas rétroactivement.
  db.exec(`UPDATE users SET email_verified = 1 WHERE email_verified IS NULL OR email_verified = 0`);
} catch (e) {
  // Colonnes déjà présentes, rien à faire.
}
// La vérification par email est en pause pour le moment : personne ne doit rester bloqué à cause d'elle.
// Cette ligne s'exécute à chaque démarrage (contrairement à la migration ci-dessus).
db.exec(`UPDATE users SET email_verified = 1 WHERE email_verified = 0 OR email_verified IS NULL`);

// ---------- Envoi d'emails transactionnels via l'API HTTP Brevo (gratuit jusqu'à 300 emails/jour) ----------
// Aucune dépendance npm nécessaire : simple requête HTTPS native.
function sendTransactionalEmail({ to, toName, subject, html }) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
      console.warn("BREVO_API_KEY manquant : email non envoyé (variable d'environnement à configurer sur Railway).");
      return resolve({ skipped: true });
    }
    const fromEmail = process.env.EMAIL_FROM || "contact@lovinia.fr";
    const fromName = process.env.EMAIL_FROM_NAME || "Lovinia";
    const payload = JSON.stringify({
      sender: { name: fromName, email: fromEmail },
      to: [{ email: to, name: toName || to }],
      subject,
      htmlContent: html,
    });
    const request = https.request(
      {
        hostname: "api.brevo.com",
        path: "/v3/smtp/email",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "api-key": apiKey,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 300) resolve(data ? JSON.parse(data) : {});
          else reject(new Error(`Brevo a renvoyé une erreur ${response.statusCode} : ${data}`));
        });
      }
    );
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

function sendVerificationEmail(email, name, token) {
  const verifyUrl = `${process.env.FRONTEND_URL || "https://lovinia.fr"}/verify-email?token=${token}`;
  return sendTransactionalEmail({
    to: email,
    toName: name,
    subject: "Confirme ton adresse email — Lovinia 💕",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#1B1223;">Bienvenue sur Lovinia, ${name} 💕</h2>
        <p style="color:#333;">Confirme ton adresse email pour activer pleinement ton compte :</p>
        <p style="margin:24px 0;">
          <a href="${verifyUrl}" style="background:#FF6B5B;color:#fff;padding:12px 26px;border-radius:10px;text-decoration:none;font-weight:bold;">Confirmer mon email</a>
        </p>
        <p style="color:#888;font-size:13px;">Ou copie ce lien dans ton navigateur : <br>${verifyUrl}</p>
        <p style="color:#aaa;font-size:12px;margin-top:24px;">Si tu n'es pas à l'origine de cette inscription, ignore simplement cet email.</p>
      </div>`,
  });
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

// ---------- Packs d'abonnement ----------
// NOTE : le paiement réel (carte, Mobile Money, Google Play Billing) n'est pas encore branché.
// Pour l'instant, s'abonner active immédiatement le pack (comme les Coins), en attendant l'intégration
// d'un vrai moyen de paiement — obligatoire via Google Play Billing pour toute vente sur Android.
const SUBSCRIPTION_PLANS = {
  gold: {
    name: "Pack Gold", priceUSD: 5,
    features: [
      "Publier des photos et vidéos privées", "Interrupteur Public/Privé sur chaque contenu",
      "Gestion des contenus privés depuis le profil", "Statistiques des contenus privés",
      "Réception de cadeaux sur les contenus privés", "Demande de retrait des gains",
    ],
  },
  premium: {
    name: "Pack Premium", priceUSD: 10,
    features: [
      "Matchs illimités", "Mise en avant du profil", "Voir qui a aimé ton profil",
      "Filtres avancés", "Priorité dans les recherches", "Boost du profil",
      "Plus de Super Likes", "Badge Premium", "Réduction sur les LoviCoins", "Statistiques détaillées",
    ],
  },
  vip: {
    name: "Pack VIP", priceUSD: 15,
    features: [
      "Tous les avantages Premium", "Consultation des photos et vidéos privées",
      "Accès aux contenus réservés VIP", "Cadeaux VIP exclusifs", "Bonus mensuel de LoviCoins",
      "Badge VIP animé", "Visibilité maximale", "Service client prioritaire",
    ],
  },
};

function isPremiumOrAbove(plan) { return plan === "premium" || plan === "vip"; }
function isGoldOrAbove(plan) { return plan === "gold" || plan === "vip"; }
function isVip(plan) { return plan === "vip"; }

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

// ---------- CORS restreint ----------
// Seuls les domaines officiels de Lovinia peuvent appeler cette API — empêche n'importe quel
// autre site de faire des requêtes vers ton backend depuis le navigateur d'un utilisateur.
const ALLOWED_ORIGINS = [
  "https://lovinia.fr",
  "https://www.lovinia.fr",
  "https://lovinia-frontend.vercel.app", // domaine de secours Vercel
];
app.use(cors({
  origin: (origin, callback) => {
    // Pas d'origine (app native/TWA, curl, requêtes serveur à serveur) : autorisé.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Origine non autorisée par CORS."));
    }
  },
  credentials: true,
}));
app.use(express.json());

// ---------- Anti-abus (rate limiting) ----------
// Fait maison, sans dépendance externe : limite le nombre de requêtes par fenêtre de temps.
// Clé par utilisateur connecté quand c'est possible (plus juste que l'IP seule, qui peut être
// partagée par plusieurs personnes sur un même réseau mobile/CGNAT et déclencher de faux blocages).
const rateLimitBuckets = new Map();
function rateLimit({ windowMs, max, keyPrefix }) {
  return (req, res, next) => {
    let identity = null;
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (token) {
      try {
        identity = `user:${jwt.verify(token, JWT_SECRET).id}`;
      } catch {
        identity = null;
      }
    }
    if (!identity) {
      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
      identity = `ip:${ip}`;
    }
    const key = `${keyPrefix}:${identity}`;
    const now = Date.now();
    let bucket = rateLimitBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateLimitBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      res.set("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: "Trop de requêtes en peu de temps. Réessaie dans quelques instants." });
    }
    next();
  };
}
// Purge périodique pour éviter une fuite mémoire sur le long terme.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (now > bucket.resetAt) rateLimitBuckets.delete(key);
  }
}, 5 * 60 * 1000);

const authRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: "auth" }); // inscription / connexion
const generalRateLimit = rateLimit({ windowMs: 60 * 1000, max: 400, keyPrefix: "api" }); // toutes les routes, par utilisateur
app.use("/api/", generalRateLimit);

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
    const user = db.prepare("SELECT suspended FROM users WHERE id = ?").get(payload.id);
    if (!user) return res.status(401).json({ error: "Compte introuvable." });
    if (user.suspended) return res.status(403).json({ error: "Ce compte a été suspendu." });
    req.userId = payload.id;
    // Marque l'utilisateur comme actif à l'instant (sert au statut "En ligne" / "Vu il y a...").
    db.prepare("UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?").run(payload.id);
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

// Champs qui font progresser la complétion du profil, avec leur poids respectif (total = 100).
const PROFILE_COMPLETION_FIELDS = [
  { key: "bio", weight: 12, check: (u) => !!u.bio && u.bio.trim().length > 0 },
  { key: "photos", weight: 15, check: (u) => safeParseArray(u.photos).length >= 2 },
  { key: "intention", weight: 10, check: (u) => !!u.intention },
  { key: "interests", weight: 10, check: (u) => safeParseArray(u.interests).length > 0 },
  { key: "profession", weight: 8, check: (u) => !!u.profession },
  { key: "city", weight: 8, check: (u) => !!u.city },
  { key: "taille", weight: 5, check: (u) => !!u.taille },
  { key: "wants_marriage", weight: 6, check: (u) => !!u.wants_marriage },
  { key: "wants_children", weight: 6, check: (u) => !!u.wants_children },
  { key: "education_level", weight: 5, check: (u) => !!u.education_level },
  { key: "has_pets", weight: 4, check: (u) => !!u.has_pets },
  { key: "drinks_alcohol", weight: 4, check: (u) => !!u.drinks_alcohol },
  { key: "smokes", weight: 3, check: (u) => !!u.smokes },
  { key: "does_sport", weight: 4, check: (u) => !!u.does_sport },
];

function computeProfileCompletion(u) {
  let score = 0;
  for (const f of PROFILE_COMPLETION_FIELDS) {
    if (f.check(u)) score += f.weight;
  }
  return Math.min(100, Math.round(score));
}

function publicUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return {
    ...rest,
    photos: safeParseArray(u.photos),
    interests: safeParseArray(u.interests),
    langues: safeParseArray(u.langues),
    blocked_locations: safeParseArray(u.blocked_locations),
    private_photos: safeParseArray(u.private_photos),
    profileCompletion: computeProfileCompletion(u),
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

async function sendPushToUser(userId, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return; // Notifications push non configurées.
  const subs = db.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?").all(userId);
  for (const sub of subs) {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      await webpush.sendNotification(pushSubscription, JSON.stringify(payload));
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(sub.id);
      }
    }
  }
}

// ---------- Auth routes ----------
app.post("/api/auth/register", authRateLimit, async (req, res) => {
  const {
    name, email, phone, password, intention,
    birthdate, genre, genre_recherche, city, profession, taille,
    bio, photos, interests, langues, acceptedTerms, orientation,
  } = req.body || {};
  if (!name || (!email && !phone) || !password) {
    return res.status(400).json({ error: "Nom, (email ou téléphone) et mot de passe sont requis." });
  }
  if (!birthdate) {
    return res.status(400).json({ error: "La date de naissance est obligatoire." });
  }
  const age = calculateAge(birthdate);
  if (age === null) {
    return res.status(400).json({ error: "Date de naissance invalide." });
  }
  if (age < 18) {
    return res.status(403).json({ error: "Lovinia est réservé aux personnes majeures (18 ans et plus).", code: "UNDERAGE" });
  }
  if (!acceptedTerms) {
    return res.status(400).json({ error: "Tu dois accepter les Conditions d'utilisation et la Politique de confidentialité pour créer un compte." });
  }
  if (email) {
    const existingEmail = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existingEmail) return res.status(409).json({ error: "Un compte existe déjà avec cet email." });
  }
  if (phone) {
    const existingPhone = db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
    if (existingPhone) return res.status(409).json({ error: "Un compte existe déjà avec ce numéro de téléphone." });
  }

  const hash = await bcrypt.hash(password, 10);
  const photosArr = Array.isArray(photos) ? photos : [];
  // Sans email, on génère un email interne unique (jamais affiché) : la colonne email reste NOT NULL UNIQUE.
  const effectiveEmail = email || `phone_${(phone || "").replace(/[^0-9]/g, "")}_${Date.now()}@lovinia.local`;
  // NOTE : la vérification par email est désactivée pour le moment (mise en pause, pas supprimée).
  // Les nouveaux comptes sont donc marqués comme "vérifiés" par défaut (email_verified = 1) pour
  // ne bloquer aucune fonctionnalité. Le token reste généré et stocké, prêt à être réactivé plus tard.
  const emailVerifyToken = crypto.randomBytes(24).toString("hex");
  const info = db
    .prepare(
      `INSERT INTO users (name, email, phone, password_hash, intention, birthdate, age, genre, genre_recherche,
        city, profession, taille, bio, img, photos, interests, langues, orientation,
        terms_accepted_at, email_verify_token, email_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, 1)`
    )
    .run(
      name, effectiveEmail, phone || null, hash, intention || "", birthdate, age,
      genre || "Non précisé", genre_recherche || "Tous", city || "",
      profession || "", taille || null, bio || "", photosArr[0] || "",
      JSON.stringify(photosArr), JSON.stringify(interests || []), JSON.stringify(langues || []),
      orientation || "",
      emailVerifyToken
    );
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
  // sendVerificationEmail(user.email, user.name, emailVerifyToken).catch(() => {}); // désactivé pour le moment
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post("/api/auth/login", authRateLimit, async (req, res) => {
  const { email, phone, password } = req.body || {};
  const identifier = email || phone;
  if (!identifier || !password) return res.status(400).json({ error: "Identifiant et mot de passe requis." });
  const user = phone && !email
    ? db.prepare("SELECT * FROM users WHERE phone = ?").get(identifier)
    : db.prepare("SELECT * FROM users WHERE email = ? OR phone = ?").get(identifier, identifier);
  if (!user) return res.status(401).json({ error: "Identifiant ou mot de passe incorrect." });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Identifiant ou mot de passe incorrect." });
  if (user.suspended) return res.status(403).json({ error: "Ce compte a été suspendu." });
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
      .prepare("INSERT INTO users (name, email, password_hash, img, email_verified) VALUES (?, ?, ?, ?, 1)")
      .run(payload.name || email.split("@")[0], email, hash, payload.picture || "");
    user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
  }

  const publicU = publicUser(user);
  const needsProfileCompletion = !user.birthdate || !user.intention || publicU.photos.length < 2;
  res.json({ token: signToken(user), user: publicU, needsProfileCompletion });
});

// Confirmation d'adresse email via le lien reçu par email
app.get("/api/auth/verify-email", (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: "Lien de vérification invalide." });
  const user = db.prepare("SELECT id FROM users WHERE email_verify_token = ?").get(token);
  if (!user) return res.status(400).json({ error: "Ce lien est invalide ou a déjà été utilisé." });
  db.prepare("UPDATE users SET email_verified = 1, email_verify_token = NULL WHERE id = ?").run(user.id);
  res.json({ success: true });
});

// Renvoyer l'email de confirmation (ex: si le premier n'est pas arrivé)
app.post("/api/auth/resend-verification", authMiddleware, authRateLimit, async (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
  if (!user) return res.status(404).json({ error: "Compte introuvable." });
  if (user.email_verified) return res.json({ success: true, alreadyVerified: true });
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("UPDATE users SET email_verify_token = ? WHERE id = ?").run(token, user.id);
  try {
    await sendVerificationEmail(user.email, user.name, token);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Échec de l'envoi de l'email. Réessaie dans quelques minutes." });
  }
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
    hideExactDistance, blockedLocations, privatePhotos,
    travelActive, travelCity, travelLat, travelLng, acceptedTerms,
    acceptGifts, giftSendersRestriction, hideGiftCount,
    phone, wantsMarriage, wantsChildren, educationLevel, hasPets, drinksAlcohol, smokes, doesSport,
    religion, astroSign,
  } = req.body || {};
  const age = birthdate ? calculateAge(birthdate) : null;
  if (birthdate && (age === null || age < 18)) {
    return res.status(403).json({ error: "Lovinia est réservé aux personnes majeures (18 ans et plus).", code: "UNDERAGE" });
  }
  if (acceptedTerms) {
    db.prepare("UPDATE users SET terms_accepted_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.userId);
  }
  if (phone) {
    const existingPhone = db.prepare("SELECT id FROM users WHERE phone = ? AND id != ?").get(phone, req.userId);
    if (existingPhone) return res.status(409).json({ error: "Ce numéro de téléphone est déjà utilisé par un autre compte." });
  }
  const primaryImg = photos && photos.length ? photos[0] : img;
  db.prepare(
    `UPDATE users SET name = COALESCE(?, name), genre = COALESCE(?, genre),
     genre_recherche = COALESCE(?, genre_recherche), city = COALESCE(?, city),
     bio = COALESCE(?, bio), img = COALESCE(?, img), intention = COALESCE(?, intention),
     birthdate = COALESCE(?, birthdate), age = COALESCE(?, age), profession = COALESCE(?, profession),
     taille = COALESCE(?, taille), photos = COALESCE(?, photos),
     interests = COALESCE(?, interests), langues = COALESCE(?, langues),
     latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude),
     invisible = COALESCE(?, invisible),
     hide_exact_distance = COALESCE(?, hide_exact_distance),
     blocked_locations = COALESCE(?, blocked_locations),
     private_photos = COALESCE(?, private_photos),
     travel_active = COALESCE(?, travel_active),
     travel_city = COALESCE(?, travel_city),
     travel_lat = COALESCE(?, travel_lat),
     travel_lng = COALESCE(?, travel_lng),
     accept_gifts = COALESCE(?, accept_gifts),
     gift_senders_restriction = COALESCE(?, gift_senders_restriction),
     hide_gift_count = COALESCE(?, hide_gift_count),
     phone = COALESCE(?, phone),
     wants_marriage = COALESCE(?, wants_marriage),
     wants_children = COALESCE(?, wants_children),
     education_level = COALESCE(?, education_level),
     has_pets = COALESCE(?, has_pets),
     drinks_alcohol = COALESCE(?, drinks_alcohol),
     smokes = COALESCE(?, smokes),
     does_sport = COALESCE(?, does_sport),
     religion = COALESCE(?, religion),
     astro_sign = COALESCE(?, astro_sign)
     WHERE id = ?`
  ).run(
    name, genre, genre_recherche, city, bio, primaryImg, intention, birthdate, age, profession, taille,
    photos ? JSON.stringify(photos) : null,
    interests ? JSON.stringify(interests) : null,
    langues ? JSON.stringify(langues) : null,
    latitude ?? null, longitude ?? null,
    invisible === undefined ? null : (invisible ? 1 : 0),
    hideExactDistance === undefined ? null : (hideExactDistance ? 1 : 0),
    blockedLocations ? JSON.stringify(blockedLocations) : null,
    privatePhotos ? JSON.stringify(privatePhotos) : null,
    travelActive === undefined ? null : (travelActive ? 1 : 0),
    travelCity ?? null, travelLat ?? null, travelLng ?? null,
    acceptGifts === undefined ? null : (acceptGifts ? 1 : 0),
    giftSendersRestriction ?? null,
    hideGiftCount === undefined ? null : (hideGiftCount ? 1 : 0),
    phone || null, wantsMarriage || null, wantsChildren || null, educationLevel || null,
    hasPets || null, drinksAlcohol || null, smokes || null, doesSport || null,
    religion || null, astroSign || null,
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
      verification_status, latitude, longitude, boosted_until, hide_exact_distance,
      wants_marriage, wants_children, education_level, has_pets, drinks_alcohol, smokes, does_sport, religion, astro_sign FROM users
    WHERE id NOT IN (${placeholders}) AND age >= ? AND age <= ? AND (invisible IS NULL OR invisible = 0) AND (suspended IS NULL OR suspended = 0)`;
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

  const me = db.prepare("SELECT latitude, longitude, interests, travel_active, travel_lat, travel_lng, blocked_locations FROM users WHERE id = ?").get(req.userId);
  const myLat = me?.travel_active ? me.travel_lat : me?.latitude;
  const myLng = me?.travel_active ? me.travel_lng : me?.longitude;

  let profiles = db.prepare(query).all(...params).map((p) => {
    const dist = distanceKm(myLat, myLng, p.latitude, p.longitude);
    let distanceKmRounded = dist == null ? null : Math.round(dist * 10) / 10;
    if (distanceKmRounded != null && p.hide_exact_distance) {
      distanceKmRounded = Math.max(1, Math.round(distanceKmRounded / 5) * 5);
    }
    return {
      ...p,
      photos: safeParseArray(p.photos),
      interests: safeParseArray(p.interests),
      langues: safeParseArray(p.langues),
      distance_km: distanceKmRounded,
      is_boosted: !!(p.boosted_until && new Date(p.boosted_until + "Z") > new Date()),
      latitude: undefined,
      longitude: undefined,
      boosted_until: undefined,
      hide_exact_distance: undefined,
    };
  });

  // Filtre pays/villes bloqués par l'utilisateur connecté.
  const blockedLocations = safeParseArray(me?.blocked_locations).map((l) => l.toLowerCase());
  if (blockedLocations.length > 0) {
    profiles = profiles.filter((p) => !blockedLocations.some((loc) => (p.city || "").toLowerCase().includes(loc)));
  }

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

  const user = db.prepare("SELECT genre, plan, coins, email_verified FROM users WHERE id = ?").get(req.userId);
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
      const me = db.prepare("SELECT name FROM users WHERE id = ?").get(req.userId);
      sendPushToUser(toUserId, {
        title: "Nouveau match sur Lovinia 💕",
        body: `${me?.name || "Quelqu'un"} et toi vous êtes plu !`,
        url: "/",
      }).catch(() => {});
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
    .prepare(
      `SELECT id, name, age, genre, city, bio, img, intention, profession, taille, photos, interests, langues, verification_status,
         wants_marriage, wants_children, education_level, has_pets, drinks_alcohol, smokes, does_sport, religion, astro_sign
       FROM users WHERE id = ?`
    )
    .get(last.to_user_id);
  if (profile) profile.photos = safeParseArray(profile.photos), profile.interests = safeParseArray(profile.interests), profile.langues = safeParseArray(profile.langues);

  res.json({ restored: profile || null });
});

// ---------- Matchs ----------
app.get("/api/matches", authMiddleware, (req, res) => {
  const rows = db
    .prepare(
      `SELECT m.id as match_id, u.id, u.name, u.age, u.city, u.img, u.last_active_at,
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

// Fiche profil complète de l'autre personne d'un match (photos, bio, tags...),
// accessible uniquement si un match existe bien entre les deux utilisateurs.
app.get("/api/matches/:matchId/profile", authMiddleware, (req, res) => {
  const match = db.prepare("SELECT * FROM matches WHERE id = ?").get(req.params.matchId);
  if (!match) return res.status(404).json({ error: "Match introuvable." });
  if (match.user_a_id !== req.userId && match.user_b_id !== req.userId) {
    return res.status(403).json({ error: "Accès refusé." });
  }
  const otherId = match.user_a_id === req.userId ? match.user_b_id : match.user_a_id;
  const p = db
    .prepare(
      `SELECT id, name, age, genre, city, bio, img, intention, profession, taille, photos, interests, langues,
         verification_status, last_active_at,
         wants_marriage, wants_children, education_level, has_pets, drinks_alcohol, smokes, does_sport, religion, astro_sign
       FROM users WHERE id = ?`
    )
    .get(otherId);
  if (!p) return res.status(404).json({ error: "Profil introuvable." });

  const me = db
    .prepare(
      `SELECT age, intention, interests, langues, wants_marriage, wants_children FROM users WHERE id = ?`
    )
    .get(req.userId);

  const otherInterests = safeParseArray(p.interests);
  const otherLangues = safeParseArray(p.langues);
  const myInterests = safeParseArray(me?.interests);
  const myLangues = safeParseArray(me?.langues);

  const sharedInterests = otherInterests.filter((i) => myInterests.includes(i));
  const sharedLangues = otherLangues.filter((l) => myLangues.includes(l));
  const sameIntention = !!me?.intention && me.intention === p.intention;
  const ageDiff = me?.age != null && p.age != null ? Math.abs(me.age - p.age) : null;
  const sameMarriageGoal = !!me?.wants_marriage && me.wants_marriage === p.wants_marriage;
  const sameChildrenGoal = !!me?.wants_children && me.wants_children === p.wants_children;

  let score = 50;
  score += Math.min(sharedInterests.length * 4, 20);
  score += sameIntention ? 15 : 0;
  score += sharedLangues.length > 0 ? 8 : 0;
  score += ageDiff !== null ? (ageDiff <= 3 ? 10 : ageDiff <= 7 ? 5 : 0) : 0;
  score += sameMarriageGoal ? 4 : 0;
  score += sameChildrenGoal ? 3 : 0;
  score = Math.min(score, 98);

  res.json({
    profile: {
      ...p,
      photos: safeParseArray(p.photos),
      interests: otherInterests,
      langues: otherLangues,
    },
    compatibility: {
      score,
      sharedInterests,
      sharedLangues,
      sameIntention,
      sameAgeRange: ageDiff !== null && ageDiff <= 5,
      sameMarriageGoal,
      sameChildrenGoal,
    },
  });
});

// ---------- PUBLICATIONS (photos/vidéos), LIKES ET COMMENTAIRES ----------

function isBlockedEitherWay(userA, userB) {
  const row = db
    .prepare(
      `SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`
    )
    .get(userA, userB, userB, userA);
  return !!row;
}

function areMatched(userA, userB) {
  const row = db
    .prepare(
      `SELECT 1 FROM matches WHERE (user_a_id = ? AND user_b_id = ?) OR (user_a_id = ? AND user_b_id = ?)`
    )
    .get(userA, userB, userB, userA);
  return !!row;
}

function decoratePost(post, requesterId) {
  const likeCount = db.prepare("SELECT COUNT(*) c FROM post_likes WHERE post_id = ?").get(post.id).c;
  const commentCount = db.prepare("SELECT COUNT(*) c FROM post_comments WHERE post_id = ?").get(post.id).c;
  const viewCount = db.prepare("SELECT COUNT(*) c FROM post_views WHERE post_id = ?").get(post.id).c;
  const likedByMe = !!db.prepare("SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?").get(post.id, requesterId);

  let mediaUrl = post.media_url;
  let locked = false;
  if (post.is_private) {
    const isOwner = post.user_id === requesterId;
    if (!isOwner) {
      const requester = db.prepare("SELECT plan FROM users WHERE id = ?").get(requesterId);
      if (!isVip(requester?.plan)) {
        mediaUrl = null; // on ne fuite jamais l'URL réelle à qui n'a pas le droit de la voir
        locked = true;
      }
    }
  }
  return { ...post, media_url: mediaUrl, locked, likeCount, commentCount, viewCount, likedByMe };
}

// Créer une publication (photo ou vidéo) sur son propre profil
app.post("/api/posts", authMiddleware, (req, res) => {
  const { mediaUrl, mediaType, caption, isPrivate } = req.body || {};
  if (!mediaUrl) return res.status(400).json({ error: "Média manquant." });
  const type = mediaType === "video" ? "video" : "photo";

  let privateFlag = 0;
  if (isPrivate) {
    const owner = db.prepare("SELECT plan, verification_status FROM users WHERE id = ?").get(req.userId);
    if (!isGoldOrAbove(owner?.plan)) {
      return res.status(403).json({ error: "Le Pack Gold est nécessaire pour publier du contenu privé.", code: "GOLD_REQUIRED" });
    }
    if (owner?.verification_status !== "verified") {
      return res.status(403).json({ error: "Seuls les profils vérifiés (badge bleu) peuvent publier du contenu privé.", code: "VERIFICATION_REQUIRED" });
    }
    privateFlag = 1;
  }

  const result = db
    .prepare("INSERT INTO posts (user_id, media_url, media_type, caption, is_private) VALUES (?, ?, ?, ?, ?)")
    .run(req.userId, mediaUrl, type, (caption || "").slice(0, 500), privateFlag);
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(result.lastInsertRowid);
  res.json({ post: decoratePost(post, req.userId) });
});

// Mes propres publications (pour les gérer)
app.get("/api/posts/mine", authMiddleware, (req, res) => {
  const rows = db.prepare("SELECT * FROM posts WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
  res.json({ posts: rows.map((p) => decoratePost(p, req.userId)) });
});

// Publications d'un autre utilisateur (affichées sur son profil)
app.get("/api/users/:userId/posts", authMiddleware, (req, res) => {
  const targetId = Number(req.params.userId);
  if (isBlockedEitherWay(req.userId, targetId)) return res.status(403).json({ error: "Accès refusé." });
  const owner = db.prepare("SELECT verification_status FROM users WHERE id = ?").get(targetId);
  const rows = db.prepare("SELECT * FROM posts WHERE user_id = ? AND moderation_status = 'approved' ORDER BY created_at DESC").all(targetId);
  res.json({ posts: rows.map((p) => ({ ...decoratePost(p, req.userId), owner_verified: owner?.verification_status === "verified" })) });
});

// Supprimer sa propre publication
app.delete("/api/posts/:postId", authMiddleware, (req, res) => {
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(req.params.postId);
  if (!post) return res.status(404).json({ error: "Publication introuvable." });
  if (post.user_id !== req.userId) return res.status(403).json({ error: "Accès refusé." });
  db.prepare("DELETE FROM post_comments WHERE post_id = ?").run(post.id);
  db.prepare("DELETE FROM post_likes WHERE post_id = ?").run(post.id);
  db.prepare("DELETE FROM posts WHERE id = ?").run(post.id);
  res.json({ success: true });
});

// Gérer les réglages de commentaires d'une publication (activer/désactiver, qui peut commenter)
app.put("/api/posts/:postId/settings", authMiddleware, (req, res) => {
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(req.params.postId);
  if (!post) return res.status(404).json({ error: "Publication introuvable." });
  if (post.user_id !== req.userId) return res.status(403).json({ error: "Accès refusé." });
  const { commentsEnabled, commentsPermission } = req.body || {};
  const enabled = commentsEnabled === false ? 0 : 1;
  const permission = commentsPermission === "matches" ? "matches" : "everyone";
  db.prepare("UPDATE posts SET comments_enabled = ?, comments_permission = ? WHERE id = ?").run(enabled, permission, post.id);
  res.json({ success: true });
});

// Aimer / retirer son like sur une publication
app.post("/api/posts/:postId/like", authMiddleware, (req, res) => {
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(req.params.postId);
  if (!post) return res.status(404).json({ error: "Publication introuvable." });
  if (isBlockedEitherWay(req.userId, post.user_id)) return res.status(403).json({ error: "Accès refusé." });
  const existing = db.prepare("SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?").get(post.id, req.userId);
  if (existing) {
    db.prepare("DELETE FROM post_likes WHERE post_id = ? AND user_id = ?").run(post.id, req.userId);
  } else {
    db.prepare("INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)").run(post.id, req.userId);
    if (post.user_id !== req.userId) {
      const liker = db.prepare("SELECT name FROM users WHERE id = ?").get(req.userId);
      sendPushToUser(post.user_id, { title: "Lovinia 💕", body: `${liker?.name || "Quelqu'un"} a aimé ta publication`, url: "/" });
    }
  }
  const likeCount = db.prepare("SELECT COUNT(*) c FROM post_likes WHERE post_id = ?").get(post.id).c;
  res.json({ liked: !existing, likeCount });
});

// Voir les commentaires d'une publication
// Enregistre qu'un utilisateur a vu une publication (une seule fois par personne, ne gonfle pas le compteur en boucle)
app.post("/api/posts/:postId/view", authMiddleware, (req, res) => {
  const post = db.prepare("SELECT id, user_id FROM posts WHERE id = ?").get(req.params.postId);
  if (!post) return res.status(404).json({ error: "Publication introuvable." });
  if (post.user_id !== req.userId) {
    db.prepare("INSERT OR IGNORE INTO post_views (post_id, viewer_id) VALUES (?, ?)").run(post.id, req.userId);
  }
  const viewCount = db.prepare("SELECT COUNT(*) c FROM post_views WHERE post_id = ?").get(post.id).c;
  res.json({ viewCount });
});

// Liste des personnes ayant vu une publication (réservé au propriétaire de la publication)
app.get("/api/posts/:postId/views", authMiddleware, (req, res) => {
  const post = db.prepare("SELECT id, user_id FROM posts WHERE id = ?").get(req.params.postId);
  if (!post) return res.status(404).json({ error: "Publication introuvable." });
  if (post.user_id !== req.userId) return res.status(403).json({ error: "Accès refusé." });
  const viewers = db
    .prepare(
      `SELECT u.id, u.name, u.img, pv.created_at as viewed_at
       FROM post_views pv JOIN users u ON u.id = pv.viewer_id
       WHERE pv.post_id = ? ORDER BY pv.created_at DESC`
    )
    .all(post.id);
  res.json({ viewers, total: viewers.length });
});

app.get("/api/posts/:postId/comments", authMiddleware, (req, res) => {
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(req.params.postId);
  if (!post) return res.status(404).json({ error: "Publication introuvable." });
  const rows = db
    .prepare(
      `SELECT c.id, c.text, c.created_at, c.user_id, u.name, u.img
       FROM post_comments c JOIN users u ON u.id = c.user_id
       WHERE c.post_id = ? ORDER BY c.created_at ASC`
    )
    .all(post.id);
  res.json({ comments: rows });
});

// Laisser un commentaire (soumis aux réglages du propriétaire de la publication)
app.post("/api/posts/:postId/comments", authMiddleware, (req, res) => {
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(req.params.postId);
  if (!post) return res.status(404).json({ error: "Publication introuvable." });
  if (isBlockedEitherWay(req.userId, post.user_id)) return res.status(403).json({ error: "Accès refusé." });
  if (!post.comments_enabled) return res.status(403).json({ error: "Les commentaires sont désactivés sur cette publication." });
  if (post.comments_permission === "matches" && post.user_id !== req.userId && !areMatched(req.userId, post.user_id)) {
    return res.status(403).json({ error: "Seules les personnes matchées avec cet utilisateur peuvent commenter." });
  }
  const text = (req.body?.text || "").trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: "Commentaire vide." });
  const result = db.prepare("INSERT INTO post_comments (post_id, user_id, text) VALUES (?, ?, ?)").run(post.id, req.userId, text);
  if (post.user_id !== req.userId) {
    const commenter = db.prepare("SELECT name FROM users WHERE id = ?").get(req.userId);
    sendPushToUser(post.user_id, { title: "Lovinia 💕", body: `${commenter?.name || "Quelqu'un"} a commenté ta publication`, url: "/" });
  }
  const comment = db
    .prepare(`SELECT c.id, c.text, c.created_at, c.user_id, u.name, u.img FROM post_comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`)
    .get(result.lastInsertRowid);
  res.json({ comment });
});

// Supprimer un commentaire : l'auteur du commentaire OU le propriétaire de la publication peut le faire
app.delete("/api/posts/:postId/comments/:commentId", authMiddleware, (req, res) => {
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(req.params.postId);
  const comment = db.prepare("SELECT * FROM post_comments WHERE id = ? AND post_id = ?").get(req.params.commentId, req.params.postId);
  if (!post || !comment) return res.status(404).json({ error: "Introuvable." });
  if (comment.user_id !== req.userId && post.user_id !== req.userId) {
    return res.status(403).json({ error: "Accès refusé." });
  }
  db.prepare("DELETE FROM post_comments WHERE id = ?").run(comment.id);
  res.json({ success: true });
});

// ---------- BOUTIQUE DE CADEAUX ----------
const GIFT_RECIPIENT_SHARE = 0.7; // Le destinataire d'un cadeau reçoit 70% de sa valeur en Coins ; 30% reviennent à la plateforme.

// Catalogue des cadeaux actifs, visible par tous les utilisateurs connectés
app.get("/api/gifts/catalog", authMiddleware, (req, res) => {
  const gifts = db.prepare("SELECT * FROM gift_catalog WHERE active = 1 ORDER BY sort_order ASC, price_coins ASC").all();
  res.json({ gifts });
});

// Compteur des cadeaux reçus sur une publication (par type de cadeau)
app.get("/api/posts/:postId/gifts", authMiddleware, (req, res) => {
  const post = db.prepare("SELECT user_id FROM posts WHERE id = ?").get(req.params.postId);
  if (!post) return res.status(404).json({ error: "Publication introuvable." });
  const owner = db.prepare("SELECT hide_gift_count FROM users WHERE id = ?").get(post.user_id);
  if (owner?.hide_gift_count && post.user_id !== req.userId) {
    return res.json({ gifts: [], total: 0, hidden: true });
  }
  const rows = db
    .prepare(
      `SELECT g.id as gift_id, g.name, g.icon, COUNT(*) as count
       FROM gifts_sent gs JOIN gift_catalog g ON g.id = gs.gift_id
       WHERE gs.post_id = ? GROUP BY g.id ORDER BY count DESC`
    )
    .all(req.params.postId);
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  res.json({ gifts: rows, total });
});

// Envoyer un cadeau sur une publication
app.post("/api/posts/:postId/gifts", authMiddleware, (req, res) => {
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(req.params.postId);
  if (!post) return res.status(404).json({ error: "Publication introuvable." });
  if (post.user_id === req.userId) return res.status(400).json({ error: "Tu ne peux pas t'envoyer un cadeau à toi-même." });
  if (isBlockedEitherWay(req.userId, post.user_id)) return res.status(403).json({ error: "Accès refusé." });

  const senderInfo = db.prepare("SELECT name, plan FROM users WHERE id = ?").get(req.userId);
  if (post.is_private && !isVip(senderInfo?.plan)) {
    return res.status(403).json({ error: "Le Pack VIP est nécessaire pour interagir avec du contenu privé.", code: "VIP_REQUIRED" });
  }

  const recipient = db.prepare("SELECT id, name, coins, verification_status, accept_gifts, gift_senders_restriction FROM users WHERE id = ?").get(post.user_id);
  if (!recipient) return res.status(404).json({ error: "Destinataire introuvable." });
  if (recipient.verification_status !== "verified") {
    return res.status(403).json({ error: "Seuls les profils vérifiés (badge bleu) peuvent recevoir des cadeaux." });
  }
  if (recipient.accept_gifts === 0) {
    return res.status(403).json({ error: "Cette personne n'accepte pas les cadeaux pour le moment." });
  }
  if (recipient.gift_senders_restriction === "verified_only") {
    const sender = db.prepare("SELECT verification_status FROM users WHERE id = ?").get(req.userId);
    if (sender?.verification_status !== "verified") {
      return res.status(403).json({ error: "Cette personne n'accepte les cadeaux que de la part de profils vérifiés." });
    }
  }

  const gift = db.prepare("SELECT * FROM gift_catalog WHERE id = ? AND active = 1").get(req.body?.giftId);
  if (!gift) return res.status(404).json({ error: "Ce cadeau n'existe pas ou n'est plus disponible." });

  const sender = db.prepare("SELECT coins FROM users WHERE id = ?").get(req.userId);
  if ((sender?.coins || 0) < gift.price_coins) {
    return res.status(402).json({ error: "Coins insuffisants pour envoyer ce cadeau.", code: "INSUFFICIENT_COINS" });
  }

  const recipientGain = Math.floor(gift.price_coins * GIFT_RECIPIENT_SHARE);
  const platformShare = gift.price_coins - recipientGain; // Les 30% restants, conservés par la plateforme.

  db.prepare("UPDATE users SET coins = coins - ? WHERE id = ?").run(gift.price_coins, req.userId);
  db.prepare("INSERT INTO coin_transactions (user_id, amount, reason) VALUES (?, ?, ?)").run(req.userId, -gift.price_coins, `Cadeau envoyé : ${gift.name}`);

  // Sur du contenu privé, le gain va au solde créateur (retirable), pas aux Coins classiques (dépensables dans l'app).
  if (post.is_private) {
    db.prepare("UPDATE users SET creator_balance = creator_balance + ? WHERE id = ?").run(recipientGain, recipient.id);
  } else {
    db.prepare("UPDATE users SET coins = coins + ? WHERE id = ?").run(recipientGain, recipient.id);
  }
  db.prepare("INSERT INTO coin_transactions (user_id, amount, reason) VALUES (?, ?, ?)").run(recipient.id, recipientGain, `Cadeau reçu : ${gift.name}${post.is_private ? " (contenu privé)" : ""}`);

  db.prepare("INSERT INTO gifts_sent (sender_id, recipient_id, post_id, gift_id) VALUES (?, ?, ?, ?)").run(req.userId, recipient.id, post.id, gift.id);
  db.prepare("INSERT INTO platform_revenue (amount, source, reference_id) VALUES (?, ?, ?)").run(platformShare, `Commission cadeau : ${gift.name}`, gift.id);

  sendPushToUser(recipient.id, {
    title: "Lovinia 💕",
    body: `${senderInfo?.name || "Quelqu'un"} t'a envoyé un cadeau ${gift.icon} ${gift.name} !`,
    url: "/",
  }).catch(() => {});

  const remainingCoins = db.prepare("SELECT coins FROM users WHERE id = ?").get(req.userId).coins;
  res.json({ success: true, gift, remainingCoins });
});

// --- Administration de la boutique (créer/modifier les cadeaux et leurs prix) ---
// --- Modération des publications (photos/vidéos) avant mise en ligne ---
app.get("/api/admin/posts/pending", adminMiddleware, (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*, u.name as author_name, u.email as author_email
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.moderation_status = 'pending' ORDER BY p.created_at ASC`
    )
    .all();
  res.json({ posts: rows });
});

app.post("/api/admin/posts/:postId/moderate", adminMiddleware, (req, res) => {
  const decision = req.body?.decision === "rejected" ? "rejected" : "approved";
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(req.params.postId);
  if (!post) return res.status(404).json({ error: "Publication introuvable." });
  db.prepare("UPDATE posts SET moderation_status = ? WHERE id = ?").run(decision, post.id);
  res.json({ success: true, decision });
});

// Revenu de la plateforme (commission de 30% sur chaque cadeau envoyé)
app.get("/api/admin/revenue", adminMiddleware, (req, res) => {
  const total = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM platform_revenue").get().total;
  const recent = db.prepare("SELECT * FROM platform_revenue ORDER BY created_at DESC LIMIT 50").all();
  const giftsSentCount = db.prepare("SELECT COUNT(*) c FROM gifts_sent").get().c;
  res.json({ totalCoins: total, giftsSentCount, recent });
});

app.get("/api/admin/gifts", adminMiddleware, (req, res) => {
  const gifts = db.prepare("SELECT * FROM gift_catalog ORDER BY sort_order ASC, id ASC").all();
  res.json({ gifts });
});

app.post("/api/admin/gifts", adminMiddleware, (req, res) => {
  const { name, icon, priceCoins } = req.body || {};
  if (!name || !icon || !priceCoins || priceCoins <= 0) {
    return res.status(400).json({ error: "Nom, icône et prix (positif) sont requis." });
  }
  const maxOrder = db.prepare("SELECT MAX(sort_order) m FROM gift_catalog").get().m || 0;
  const result = db
    .prepare("INSERT INTO gift_catalog (name, icon, price_coins, active, sort_order) VALUES (?, ?, ?, 1, ?)")
    .run(name.slice(0, 40), icon.slice(0, 8), Math.round(priceCoins), maxOrder + 1);
  const gift = db.prepare("SELECT * FROM gift_catalog WHERE id = ?").get(result.lastInsertRowid);
  res.json({ gift });
});

app.put("/api/admin/gifts/:giftId", adminMiddleware, (req, res) => {
  const gift = db.prepare("SELECT * FROM gift_catalog WHERE id = ?").get(req.params.giftId);
  if (!gift) return res.status(404).json({ error: "Cadeau introuvable." });
  const name = req.body?.name ?? gift.name;
  const icon = req.body?.icon ?? gift.icon;
  const priceCoins = req.body?.priceCoins != null ? Math.round(req.body.priceCoins) : gift.price_coins;
  const active = req.body?.active != null ? (req.body.active ? 1 : 0) : gift.active;
  db.prepare("UPDATE gift_catalog SET name = ?, icon = ?, price_coins = ?, active = ? WHERE id = ?")
    .run(name.slice(0, 40), icon.slice(0, 8), priceCoins, active, gift.id);
  res.json({ gift: db.prepare("SELECT * FROM gift_catalog WHERE id = ?").get(gift.id) });
});

app.delete("/api/admin/gifts/:giftId", adminMiddleware, (req, res) => {
  db.prepare("UPDATE gift_catalog SET active = 0 WHERE id = ?").run(req.params.giftId);
  res.json({ success: true });
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

// ---------- Détection de coordonnées personnelles dans les messages ----------
// Objectif : empêcher l'échange de numéros de téléphone, emails, liens et pseudos
// de réseaux sociaux tant que les DEUX personnes ne sont pas des profils vérifiés (badge bleu).
const CONTACT_INFO_PATTERNS = [
  // Numéro de téléphone : au moins 8 chiffres, avec ou sans indicatif, séparateurs variés
  /(\+?\d[\s.\-]?){8,}\d/,
  // Adresse email
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  // Lien web (http/https/www)
  /\b(https?:\/\/|www\.)\S+/i,
  // Réseau social nommé explicitement, suivi d'un identifiant probable
  /\b(whatsapp|wa\.me|telegram|t\.me|instagram|insta|snapchat|snap|facebook|fb\.com|messenger|tiktok)\b\s*[:@]?\s*[\w._-]{2,}/i,
  // Pseudo précédé de @ (identifiant réseau social)
  /@[a-z0-9._]{3,}/i,
];

function containsContactInfo(text) {
  return CONTACT_INFO_PATTERNS.some((re) => re.test(text));
}

app.post("/api/matches/:matchId/messages", authMiddleware, (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Message vide." });
  const trimmed = text.trim();

  const match = db.prepare("SELECT * FROM matches WHERE id = ?").get(req.params.matchId);
  if (!match) return res.status(404).json({ error: "Match introuvable." });
  if (match.user_a_id !== req.userId && match.user_b_id !== req.userId) {
    return res.status(403).json({ error: "Accès refusé." });
  }
  const recipientId = match.user_a_id === req.userId ? match.user_b_id : match.user_a_id;

  if (containsContactInfo(trimmed)) {
    const sender = db.prepare("SELECT verification_status FROM users WHERE id = ?").get(req.userId);
    const recipient = db.prepare("SELECT verification_status FROM users WHERE id = ?").get(recipientId);
    const bothVerified = sender?.verification_status === "verified" && recipient?.verification_status === "verified";
    if (!bothVerified) {
      return res.status(403).json({
        error: "Pour la sécurité de tous, l'échange de coordonnées personnelles (téléphone, email, réseaux sociaux, liens...) n'est autorisé qu'entre deux profils vérifiés (badge bleu).",
        code: "CONTACT_INFO_BLOCKED",
      });
    }
  }

  const info = db
    .prepare("INSERT INTO messages (match_id, sender_id, text, is_read) VALUES (?, ?, ?, 0)")
    .run(req.params.matchId, req.userId, trimmed);
  const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(info.lastInsertRowid);
  res.json({ message });

  // Notification push au destinataire (ne bloque pas la réponse).
  const sender = db.prepare("SELECT name FROM users WHERE id = ?").get(req.userId);
  sendPushToUser(recipientId, {
    title: sender?.name || "Nouveau message",
    body: trimmed.slice(0, 120),
    url: "/",
  }).catch(() => {});
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

app.get("/api/admin/users", adminMiddleware, (req, res) => {
  const search = `%${req.query.search || ""}%`;
  const rows = db
    .prepare(
      `SELECT id, name, email, genre, city, plan, suspended, verification_status, created_at
       FROM users WHERE name LIKE ? OR email LIKE ? ORDER BY created_at DESC LIMIT 100`
    )
    .all(search, search);
  res.json({ users: rows });
});

app.post("/api/admin/users/:userId/suspend", adminMiddleware, (req, res) => {
  db.prepare("UPDATE users SET suspended = 1 WHERE id = ?").run(req.params.userId);
  res.json({ ok: true });
});

app.post("/api/admin/users/:userId/reactivate", adminMiddleware, (req, res) => {
  db.prepare("UPDATE users SET suspended = 0 WHERE id = ?").run(req.params.userId);
  res.json({ ok: true });
});

app.delete("/api/admin/users/:userId", adminMiddleware, (req, res) => {
  const id = req.params.userId;
  const matchIds = db.prepare("SELECT id FROM matches WHERE user_a_id = ? OR user_b_id = ?").all(id, id).map((m) => m.id);
  const deleteAll = db.transaction(() => {
    for (const matchId of matchIds) db.prepare("DELETE FROM messages WHERE match_id = ?").run(matchId);
    db.prepare("DELETE FROM matches WHERE user_a_id = ? OR user_b_id = ?").run(id, id);
    db.prepare("DELETE FROM swipes WHERE from_user_id = ? OR to_user_id = ?").run(id, id);
    db.prepare("DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?").run(id, id);
    db.prepare("DELETE FROM reports WHERE reporter_id = ? OR reported_id = ?").run(id, id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  });
  deleteAll();
  res.json({ ok: true });
});

app.get("/api/admin/stats", adminMiddleware, (req, res) => {
  const totalUsers = db.prepare("SELECT COUNT(*) as n FROM users").get().n;
  const totalMatches = db.prepare("SELECT COUNT(*) as n FROM matches").get().n;
  const totalMessages = db.prepare("SELECT COUNT(*) as n FROM messages").get().n;
  const pendingReports = db.prepare("SELECT COUNT(*) as n FROM reports WHERE status = 'pending'").get().n;
  const pendingVerifications = db.prepare("SELECT COUNT(*) as n FROM users WHERE verification_status = 'pending'").get().n;
  const newUsersToday = db.prepare("SELECT COUNT(*) as n FROM users WHERE date(created_at) = date('now')").get().n;
  res.json({ totalUsers, totalMatches, totalMessages, pendingReports, pendingVerifications, newUsersToday });
});

// ---------- Album privé ----------
app.post("/api/private-album/request/:ownerId", authMiddleware, (req, res) => {
  const ownerId = Number(req.params.ownerId);
  if (ownerId === req.userId) return res.status(400).json({ error: "Action impossible." });
  db.prepare(
    `INSERT INTO private_album_access (owner_id, requester_id, status) VALUES (?, ?, 'pending')
     ON CONFLICT(owner_id, requester_id) DO NOTHING`
  ).run(ownerId, req.userId);
  res.json({ requested: true });
});

app.get("/api/private-album/requests", authMiddleware, (req, res) => {
  const rows = db
    .prepare(
      `SELECT pa.id, pa.requester_id, u.name, u.img, pa.status, pa.created_at
       FROM private_album_access pa JOIN users u ON u.id = pa.requester_id
       WHERE pa.owner_id = ? AND pa.status = 'pending' ORDER BY pa.created_at DESC`
    )
    .all(req.userId);
  res.json({ requests: rows });
});

app.post("/api/private-album/requests/:requestId/decision", authMiddleware, (req, res) => {
  const { approve } = req.body || {};
  const request = db.prepare("SELECT * FROM private_album_access WHERE id = ? AND owner_id = ?").get(req.params.requestId, req.userId);
  if (!request) return res.status(404).json({ error: "Demande introuvable." });
  db.prepare("UPDATE private_album_access SET status = ? WHERE id = ?").run(approve ? "approved" : "denied", req.params.requestId);
  res.json({ ok: true });
});

app.get("/api/private-album/:ownerId", authMiddleware, (req, res) => {
  const ownerId = Number(req.params.ownerId);
  if (ownerId === req.userId) {
    const me = db.prepare("SELECT private_photos FROM users WHERE id = ?").get(req.userId);
    return res.json({ photos: safeParseArray(me?.private_photos), status: "approved" });
  }
  const access = db.prepare("SELECT status FROM private_album_access WHERE owner_id = ? AND requester_id = ?").get(ownerId, req.userId);
  if (access?.status === "approved") {
    const owner = db.prepare("SELECT private_photos FROM users WHERE id = ?").get(ownerId);
    return res.json({ photos: safeParseArray(owner?.private_photos), status: "approved" });
  }
  res.json({ photos: [], status: access?.status || "none" });
});

// ---------- Notifications push ----------
app.get("/api/push/vapid-public-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post("/api/push/subscribe", authMiddleware, (req, res) => {
  const { endpoint, keys } = req.body?.subscription || req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: "Abonnement invalide." });
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
  ).run(req.userId, endpoint, keys.p256dh, keys.auth);
  res.json({ subscribed: true });
});

app.post("/api/push/unsubscribe", authMiddleware, (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  res.json({ unsubscribed: true });
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

// Portefeuille : solde + historique des mouvements de Coins (gains et dépenses)
app.get("/api/me/wallet", authMiddleware, (req, res) => {
  const row = db.prepare("SELECT coins FROM users WHERE id = ?").get(req.userId);
  const transactions = db
    .prepare("SELECT id, amount, reason, created_at FROM coin_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100")
    .all(req.userId);
  res.json({ coins: row?.coins || 0, transactions });
});

// ---------- Abonnements (Gold / Premium / VIP) ----------

// Catalogue public des 3 packs
app.get("/api/plans", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT plan, plan_expires_at FROM users WHERE id = ?").get(req.userId);
  res.json({ plans: SUBSCRIPTION_PLANS, currentPlan: user?.plan || "free", planExpiresAt: user?.plan_expires_at || null });
});

// S'abonner à un pack. NOTE : paiement réel pas encore branché (voir avertissement en haut du fichier
// pour GIFT_RECIPIENT_SHARE) — active immédiatement le pack, comme un "mode démo" en attendant
// l'intégration de Google Play Billing / Stripe / Mobile Money.
app.post("/api/subscribe", authMiddleware, (req, res) => {
  const planKey = req.body?.plan;
  if (!SUBSCRIPTION_PLANS[planKey]) return res.status(400).json({ error: "Pack inconnu." });
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  db.prepare("UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?").run(planKey, expiresAt.toISOString(), req.userId);
  res.json({ success: true, plan: planKey, planExpiresAt: expiresAt.toISOString() });
});

// Se désabonner (retour au plan gratuit)
app.post("/api/unsubscribe", authMiddleware, (req, res) => {
  db.prepare("UPDATE users SET plan = 'free', plan_expires_at = NULL WHERE id = ?").run(req.userId);
  res.json({ success: true });
});

// Tableau de bord créateur (réservé aux détenteurs du Pack Gold ou VIP)
app.get("/api/me/creator-dashboard", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT plan, creator_balance FROM users WHERE id = ?").get(req.userId);
  if (!isGoldOrAbove(user?.plan)) {
    return res.status(403).json({ error: "Le Pack Gold est nécessaire pour accéder au tableau de bord créateur." });
  }
  const privatePosts = db.prepare("SELECT * FROM posts WHERE user_id = ? AND is_private = 1 ORDER BY created_at DESC").all(req.userId);
  const postsWithStats = privatePosts.map((p) => {
    const gifts = db
      .prepare(
        `SELECT COUNT(*) as count, COALESCE(SUM(g.price_coins), 0) as totalSpent
         FROM gifts_sent gs JOIN gift_catalog g ON g.id = gs.gift_id WHERE gs.post_id = ?`
      )
      .get(p.id);
    const viewCount = db.prepare("SELECT COUNT(*) c FROM post_views WHERE post_id = ?").get(p.id).c;
    return { id: p.id, media_url: p.media_url, media_type: p.media_type, created_at: p.created_at, giftCount: gifts.count, viewCount };
  });
  const totalGiftsReceived = db
    .prepare(
      `SELECT COUNT(*) c FROM gifts_sent gs JOIN posts p ON p.id = gs.post_id WHERE gs.recipient_id = ? AND p.is_private = 1`
    )
    .get(req.userId).c;
  const withdrawals = db
    .prepare("SELECT id, amount_coins, status, created_at, processed_at FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC")
    .all(req.userId);
  res.json({
    balance: user?.creator_balance || 0,
    totalGiftsReceived,
    posts: postsWithStats,
    withdrawals,
  });
});

// Demander un retrait des gains créateur
app.post("/api/me/withdraw", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT plan, creator_balance FROM users WHERE id = ?").get(req.userId);
  if (!isGoldOrAbove(user?.plan)) {
    return res.status(403).json({ error: "Le Pack Gold est nécessaire pour demander un retrait." });
  }
  const amount = Math.floor(req.body?.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: "Montant invalide." });
  if (amount > (user.creator_balance || 0)) {
    return res.status(402).json({ error: "Solde insuffisant pour ce retrait." });
  }
  db.prepare("UPDATE users SET creator_balance = creator_balance - ? WHERE id = ?").run(amount, req.userId);
  const info = db
    .prepare("INSERT INTO withdrawal_requests (user_id, amount_coins, status) VALUES (?, ?, 'pending')")
    .run(req.userId, amount);
  res.json({ success: true, withdrawalId: info.lastInsertRowid, remainingBalance: user.creator_balance - amount });
});

// --- Administration des demandes de retrait ---
app.get("/api/admin/withdrawals", adminMiddleware, (req, res) => {
  const rows = db
    .prepare(
      `SELECT w.*, u.name as user_name, u.email as user_email
       FROM withdrawal_requests w JOIN users u ON u.id = w.user_id
       WHERE w.status = 'pending' ORDER BY w.created_at ASC`
    )
    .all();
  res.json({ withdrawals: rows });
});

app.post("/api/admin/withdrawals/:id/process", adminMiddleware, (req, res) => {
  const decision = req.body?.decision === "rejected" ? "rejected" : "paid";
  const withdrawal = db.prepare("SELECT * FROM withdrawal_requests WHERE id = ?").get(req.params.id);
  if (!withdrawal) return res.status(404).json({ error: "Demande introuvable." });
  if (decision === "rejected") {
    // Le montant est recrédité au solde créateur si la demande est refusée.
    db.prepare("UPDATE users SET creator_balance = creator_balance + ? WHERE id = ?").run(withdrawal.amount_coins, withdrawal.user_id);
  }
  db.prepare("UPDATE withdrawal_requests SET status = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?").run(decision, withdrawal.id);
  res.json({ success: true, decision });
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

// ---------- Filet de sécurité global ----------
// Si une route plante pour une raison imprévue, Express renvoie par défaut une page HTML
// d'erreur — ce qui casse le frontend (qui attend du JSON) avec un message confus du genre
// "Unexpected token '<'" ou "The string did not match the expected pattern" côté navigateur.
// Ce gestionnaire s'assure qu'on renvoie TOUJOURS du JSON, même en cas d'erreur inattendue.
app.use((req, res) => {
  res.status(404).json({ error: "Route introuvable." });
});
app.use((err, req, res, next) => {
  console.error("Erreur non gérée :", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Une erreur inattendue est survenue sur le serveur. Réessaie dans un instant." });
});

app.listen(PORT, () => {
  console.log(`API de l'appli de rencontre lancée sur http://localhost:${PORT}`);
  // Diagnostic temporaire complet : vérifie TOUTES les variables attendues, pour savoir si le
  // problème touche uniquement Brevo ou bien toutes les variables d'environnement du service.
  const expectedVars = [
    "BREVO_API_KEY", "EMAIL_FROM", "EMAIL_FROM_NAME", "FRONTEND_URL",
    "JWT_SECRET", "ADMIN_SECRET", "DB_PATH", "GOOGLE_CLIENT_ID",
    "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY",
  ];
  console.log("========== [DIAGNOSTIC] État des variables d'environnement ==========");
  for (const key of expectedVars) {
    const val = process.env[key];
    if (val) {
      console.log(`[DIAGNOSTIC] ${key} = PRÉSENTE (longueur ${val.length}, commence par "${val.slice(0, 4)}...")`);
    } else {
      console.log(`[DIAGNOSTIC] ${key} = ABSENTE (undefined)`);
    }
  }
  console.log("=======================================================================");
});
