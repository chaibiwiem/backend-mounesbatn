# CLAUDE.md — Mounesba

Ce fichier fournit le contexte du projet à Claude Code. À lire au début de chaque session.

---

## Vue d'ensemble

**Mounesba** est une plateforme web de mise en relation pour les services événementiels et de bien-être en Tunisie et dans la région MENA (mariages, fiançailles, anniversaires, spa, etc.). À l'image d'un Booking.com dédié aux célébrations, elle connecte les organisateurs d'événements avec des prestataires locaux.

**Modèle** : mise en relation (lead + abonnement). La plateforme **ne traite aucun paiement** — le règlement se fait en direct entre client et prestataire (cash ou virement RIB).

---

## Règles structurantes (NE JAMAIS VIOLER)

1. **Aucun paiement en ligne.** Pas de Stripe, Paymee, carte bancaire ni acompte traité par la plateforme. Les montants (contrats, factures, CRM) sont **déclaratifs**, saisis par le prestataire.
2. **Modèle lead**, pas de réservation transactionnelle. Le parcours principal = demande de devis via formulaire → le prestataire recontacte le client.
3. **Monétisation par abonnement** prestataire uniquement (Starter gratuit, Pro 59 DT/mois, Premium 119 DT/mois). **Aucune commission.**
4. **Plateforme web uniquement.** Pas d'application mobile native (le site est responsive).
5. **Authentification email/mot de passe uniquement.** Pas d'OAuth Google/Facebook. Vérification par email.

---

## Stack technique

| Couche | Techno |
|---|---|
| Frontend | React.js (Vite) + React Router + Axios |
| Backend | Express.js (Node.js) |
| ORM | Sequelize |
| Base de données | MySQL |
| Auth | JWT + bcrypt |
| Emails | Nodemailer |
| Upload fichiers | Multer |
| PDF (contrats/factures) | pdfkit ou puppeteer |
| Cartes | Google Maps API |
| Hébergement | VPS OVH + Nginx (reverse proxy) + PM2 |

---

## Structure du projet (monorepo)

```
farahbooking/
├── CLAUDE.md
├── docs/
│   ├── farahbooking_schema.sql   # schéma MySQL de référence
│   ├── MODULES.md
│   ├── cahier_des_charges.docx
│   └── user_stories.docx
├── backend/
│   ├── src/
│   │   ├── routes/        # auth, listings, leads, reviews, subscriptions...
│   │   ├── controllers/
│   │   ├── models/        # modèles Sequelize + index.js (associations)
│   │   ├── middleware/     # auth.js (JWT), upload.js (multer), security
│   │   ├── services/      # emailService, pdfService
│   │   └── config/        # database.js
│   ├── server.js
│   └── .env.example
└── frontend/
    ├── src/
    │   ├── components/    # ContactForm, ListingCard, Navbar...
    │   ├── pages/         # Home, SearchResults, ListingDetail, dashboards
    │   ├── hooks/
    │   ├── context/       # AuthContext
    │   ├── services/      # appels API (axios)
    │   └── utils/
    ├── main.jsx
    └── vite.config.js
```

---

## Modèle de données (17 tables)

Voir `docs/farahbooking_schema.sql` pour la source de vérité. Tables clés :

- **users** : clients, prestataires, admins (champ `role`)
- **categories** : 8 catégories principales + 28 sous-catégories (auto-référence `parent_id`)
- **listings** : fiches prestataires publiques (statut : pending/active/suspended/rejected), soft delete via `deleted_at`
- **images**, **packages**, **availability**, **promotions** : contenu d'une fiche
- **leads** : demandes de devis (cœur du modèle) — statuts : new/answered/late/converted/lost
- **clients** : mini-CRM prestataire (tags : nouveau/recurrent/vip)
- **bookings** : événements confirmés hors-ligne — trace d'un lead converti OU création manuelle directe par le prestataire (client trouvé hors plateforme, module M5)
- **reviews** (+ review_photos) : avis vérifiés (1 par booking)
- **contracts**, **invoices** : documents PDF déclaratifs
- **subscriptions** : abonnements prestataires
- **favorites**, **disputes** : favoris client, litiges

---

## Catégories (8 principales)

A. Lieux de mariage · B. Beauté & Bien-être · C. Décoration · D. Traiteur & Pâtisserie · E. Mode · F. Image & Médias · G. Transport · H. Animation

Chaque catégorie contient des **sous-catégories = types de prestataires** (ex. DJ, Traiteur, Fleuriste). Un prestataire s'inscrit sous une sous-catégorie précise.

---

## Règles métier importantes

- **Tags CRM** : Nouveau (1 événement), Récurrent (2+), VIP (3+ OU total déclaré > 5000 DT). Surchargeables manuellement.
- **Note moyenne** : moyenne arithmétique des avis vérifiés, arrondie à 1 décimale. Prestataire sans avis → "Nouveau prestataire".
- **Lead sans réponse** : passe en `late` après 48h. Taux de réponse < 50% → retire le badge "Réponse en 24h".
- **Avis** : uniquement après un booking terminé, 1 seul par booking, `is_verified` auto, `provider_id` dérivé du booking.
- **Validation prestataire** : compte `pending` non visible jusqu'à validation admin (délai cible 72h).

---

## Sécurité (À APPLIQUER SYSTÉMATIQUEMENT)

**Authentification**
- Mots de passe hachés avec bcrypt (coût 12). Jamais stockés en clair.
- JWT à courte durée (15 min - 1h) + refresh token. `JWT_SECRET` long et aléatoire, jamais commité.
- Rate limiting : non implémenté. À réintroduire avant la mise en production (express-rate-limit sur `/auth`, `/leads` et `/reviews`, avec `app.set('trust proxy', 1)`).

**Protection API (Express)**
- `helmet` actif avec une CSP adaptée (`backend/src/app.js`) : `default-src 'self'`, `imgSrc` autorise les tuiles OpenStreetMap (carte Leaflet, `https://*.tile.openstreetmap.org`) + `data:`, `styleSrc`/`fontSrc` autorisent Google Fonts (`fonts.googleapis.com`/`fonts.gstatic.com`, pour Playfair Display), `connectSrc 'self'`, `crossOriginResourcePolicy: 'cross-origin'`. Ne jamais revenir à une CSP par défaut sans ces exceptions : ça casse la carte et les polices.
- CORS avec liste blanche de domaines (jamais `*` en production).
- `NODE_ENV=production` en prod (masque les erreurs détaillées).

**Validation & injection**
- Valider TOUTES les entrées avec `express-validator` (format email, longueurs max, types) — appliqué sur toutes les routes POST/PATCH ; chaque controller vérifie `validationResult(req)` en tête de fonction.
- Injection SQL : aucune requête brute/concaténée nulle part dans le projet — 100% de l'accès BDD passe par les méthodes Sequelize (paramétrées automatiquement). Si `sequelize.query(...)` devient un jour nécessaire, utiliser systématiquement `replacements` + `QueryTypes`, jamais de template literal avec une variable.
- Ne jamais faire confiance aux données client.

**XSS**
- Ne jamais utiliser `dangerouslySetInnerHTML`. React échappe le rendu par défaut (`{variable}` en JSX) — vérifié, aucune insertion HTML brute côté frontend.
- Champs texte libres nettoyés en défense en profondeur avant enregistrement, via `sanitize-html` (`backend/src/middleware/sanitize.js`, `sanitizeFields([...])` — retire toute balise HTML, `allowedTags: []`) : `listings.title`/`description`, `packages.name`/`description`, `leads.message`, `reviews.comment`/`reply`, `users.firstName`/`lastName` (inscription, profil, création prestataire par l'admin). Note : `sanitize-html` doit rester **épinglé à `2.16.0`** — les versions ≥ 2.17 tirent `htmlparser2` ^12 (ESM-only), qui casse `require()` en CommonJS (serveur ET tests Jest) ; ne jamais faire `npm update`/`npm install sanitize-html` sans vérifier cette contrainte.

**CSRF**
- Non applicable dans la configuration actuelle : l'authentification se fait par JWT envoyé via l'en-tête `Authorization: Bearer <token>` (stocké en `localStorage` côté frontend, jamais en cookie — voir `frontend/src/services/api.js`). Le navigateur n'attache jamais cet en-tête automatiquement lors d'une requête cross-site forgée, contrairement à un cookie de session : l'attaque CSRF classique ne s'applique donc pas. Pas de middleware CSRF dédié (`csurf` est déprécié, ne pas l'installer).
- Si l'authentification passe un jour par cookie (session, refresh token en cookie `httpOnly`...), il faudra alors : `httpOnly: true, secure: true, sameSite: 'strict'` sur ce cookie, + un middleware vérifiant l'en-tête `Origin`/`Referer` contre `FRONTEND_URL` sur POST/PUT/PATCH/DELETE.

**Uploads (photos, documents légaux)**
- Vérifier le type MIME réel (pas juste l'extension), JPG/PNG uniquement, max 5 Mo.
- Renommer les fichiers (jamais le nom d'origine). Stocker hors racine web ou sur Cloudinary.

**Emails (délivrabilité / anti-spam)**
- Chaque email envoyé (`emailService.sendMail`) inclut désormais automatiquement une partie texte brut (`htmlToText`, dérivée du HTML) en plus du HTML, et un "From" avec nom affiché (`withDisplayName`, ex. `"Mounesba" <contact@mounesba.tn>`) pour les emails système (plateforme) — un email HTML-only envoyé sans nom d'expéditeur est un signal classique de spam.
- **Limite structurelle non corrigeable en code** : en dev, `SMTP_HOST`/`SMTP_USER` pointent vers un compte Gmail personnel (`smtp.gmail.com`). Les emails transactionnels (mot de passe temporaire + lien de connexion) envoyés depuis un compte Gmail grand public vers d'autres adresses Gmail atterrissent très souvent en spam (réputation d'expéditeur + contenu ressemblant à un modèle de phishing), même avec SPF/DKIM valides. **Avant la mise en production**, configurer un vrai domaine expéditeur authentifié (SPF + DKIM + DMARC) via Resend (déjà supporté par `sendViaResend`, voir Parametres admin > Email SMTP) ou un fournisseur SMTP transactionnel dédié (Mailgun, Amazon SES...) — ne jamais utiliser `smtp.gmail.com` en production.

**Contrôle d'accès (autorisation)**
- Un prestataire ne modifie QUE sa propre fiche (`listing.user_id === req.user.id`).
- Un client ne voit QUE ses propres leads.
- Routes `/api/admin/*` réservées au rôle admin (middleware dédié). Sous-rôles admin
  (`users.admin_role`) : Super Admin, Modérateur, Support client, Analyste — gérés par
  `requireAdminRole(...)` pour les actions de gestion des prestataires (modifier/statut/
  suppression), voir MODULES.md M10.

**Données personnelles**
- HTTPS obligatoire (Let's Encrypt sur OVH).
- Documents légaux sensibles (patente, CIN, RIB) : accès restreint, chiffrement au repos si possible.
- Sauvegardes quotidiennes de la base. Conformité RGPD + loi tunisienne.

**Serveur / secrets**
- `.env` jamais commité. Pare-feu (ufw) : ports 22, 80, 443 uniquement.
- SSH par clés (désactiver le login par mot de passe). Système tenu à jour.

---

## Conventions de code

- **Nommage** : camelCase (JS/variables), PascalCase (composants React, modèles), snake_case (colonnes SQL).
- **Commits** : format conventionnel (`feat:`, `fix:`, `refactor:`, `docs:`).
- **API** : REST, réponses JSON, codes HTTP standard (201 création, 403 interdit, 409 conflit).
- **Validation** : express-validator côté backend sur toutes les entrées.
- **Secrets** : jamais commités. Utiliser `.env` (structure dans `.env.example`).
- **Erreurs** : middleware d'erreur centralisé côté Express ; messages clairs côté React.

---

## Variables d'environnement (backend/.env)

```
NODE_ENV=production
PORT=5000
DATABASE_URL=mysql://user:password@localhost:3306/farahbooking
JWT_SECRET=...
SMTP_HOST=smtp.votre-fournisseur.com
SMTP_USER=contact@mounesba.tn
SMTP_PASS=...
GOOGLE_MAPS_API_KEY=...
ENCRYPTION_KEY=...
```

---

## Ordre de développement (MVP d'abord)

1. Structure + base de données (modèles Sequelize + seed catégories)
2. Authentification (email/mot de passe)
3. Recherche + fiches prestataires
4. **Demande de devis / lead** (cœur du produit)
5. Espace prestataire + mini-CRM
6. Avis vérifiés
7. Validation admin
8. Abonnements
9. Contrats/factures PDF + finitions + déploiement

Après chaque phase : vérifier les critères d'acceptation des user stories correspondantes (`docs/user_stories.docx`).
