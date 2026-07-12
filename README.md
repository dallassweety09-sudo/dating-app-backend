# Backend — Application de rencontre

API REST en Node.js / Express avec base de données SQLite (fichier local, aucune installation de serveur de base de données requise).

## Fonctionnalités
- Inscription / connexion (mot de passe hashé + token JWT)
- Profil utilisateur (lecture / mise à jour)
- Découverte de profils avec filtres (genre, âge)
- Swipe (like / pass / superlike) avec détection automatique de match
- Liste des matchs
- Messagerie par match (lecture / envoi)

## 1. Installation

```bash
cd dating-app-backend
npm install
cp .env.example .env
```

Ouvre `.env` et remplace `JWT_SECRET` par une longue chaîne aléatoire (ex: générée avec `openssl rand -hex 32`).

## 2. Lancer en local

```bash
npm start
```

Le serveur tourne sur `http://localhost:4000`. Un fichier `dating_app.db` (SQLite) est créé automatiquement au premier lancement.

## 3. Tester rapidement

```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Aïcha","email":"aicha@test.com","password":"motdepasse123"}'
```

Tu reçois un `token` à réutiliser dans l'en-tête `Authorization: Bearer <token>` pour les routes protégées (`/api/discover`, `/api/swipe`, `/api/matches`, etc.)

## 4. Connecter le frontend

Dans `DatingAppMVP.jsx`, remplace :
```js
const API_BASE = "";
```
par l'URL de ton backend, par exemple :
```js
const API_BASE = "http://localhost:4000";       // en local
const API_BASE = "https://ton-app.up.railway.app"; // en ligne
```

## 5. Déployer le backend en ligne (gratuit pour démarrer)

**Option recommandée : Railway ou Render**
1. Crée un compte sur [railway.app](https://railway.app) ou [render.com](https://render.com)
2. Connecte ton repo GitHub contenant ce dossier `dating-app-backend`
3. Railway/Render détecte Node.js automatiquement (`npm install` puis `npm start`)
4. Ajoute la variable d'environnement `JWT_SECRET` dans les paramètres du service
5. Une fois déployé, tu obtiens une URL publique (ex: `https://xxx.up.railway.app`) — c'est ton `API_BASE`

Remarque : SQLite fonctionne très bien pour un MVP, mais sur ces plateformes le disque peut être réinitialisé entre les déploiements. Pour une vraie mise en production avec des données durables, migre vers PostgreSQL managé (Railway et Render en proposent en un clic) — la structure des requêtes SQL ci-dessus est proche, l'adaptation est mineure.

## Routes disponibles

| Méthode | Route | Description |
|---|---|---|
| POST | /api/auth/register | Créer un compte |
| POST | /api/auth/login | Se connecter |
| GET | /api/me | Récupérer mon profil |
| PUT | /api/me | Modifier mon profil |
| GET | /api/discover?genre=&ageMin=&ageMax= | Profils à découvrir |
| POST | /api/swipe | Liker / passer un profil |
| GET | /api/matches | Mes matchs |
| GET | /api/matches/:matchId/messages | Messages d'une conversation |
| POST | /api/matches/:matchId/messages | Envoyer un message |
