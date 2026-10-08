const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const authRoutes = require('./routes/auth');
const categoryRoutes = require('./routes/categories');
const cityRoutes = require('./routes/cities');
const listingRoutes = require('./routes/listings');
const leadRoutes = require('./routes/leads');
const commissionRoutes = require('./routes/commissions');
const imageRoutes = require('./routes/images');
const videoRoutes = require('./routes/videos');
const packageRoutes = require('./routes/packages');
const availabilityRoutes = require('./routes/availability');
const promotionRoutes = require('./routes/promotions');
const clientRoutes = require('./routes/clients');
const contractRoutes = require('./routes/contracts');
const invoiceRoutes = require('./routes/invoices');
const reviewRoutes = require('./routes/reviews');
const bookingRoutes = require('./routes/bookings');
const subscriptionRoutes = require('./routes/subscriptions');
const favoriteRoutes = require('./routes/favorites');
const vehicleRoutes = require('./routes/vehicles');
const vehicleBookingRoutes = require('./routes/vehicleBookings');
const vehicleDecorationRoutes = require('./routes/vehicleDecorations');
const vehicleOptionRoutes = require('./routes/vehicleOptions');
const providerEventRoutes = require('./routes/providerEvents');
const adminRoutes = require('./routes/admin');
const documentRoutes = require('./routes/documents');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Derriere Nginx (reverse proxy) en production : l'IP reelle du client est
// lue dans X-Forwarded-For (1 seul proxy de confiance), indispensable au rate
// limiting par IP s'il est reintroduit - sinon tous les visiteurs
// partageraient l'IP de Nginx.
app.set('trust proxy', 1);

// CORS avec liste blanche de domaines (jamais * en production) — CLAUDE.md
// FRONTEND_URL peut inclure un chemin (ex. https://exemple.com/mounesba) car
// emailService.js s'en sert aussi comme base pour les liens dans les emails
// (verification, reinitialisation, PDF...). L'en-tete Origin envoye par le
// navigateur ne contient jamais de chemin, donc on ne garde que
// schema+hote+port pour la whitelist CORS.
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean)
  .map((url) => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  })
  .filter(Boolean);

// CSP adaptee pour autoriser les tuiles OpenStreetMap (carte Leaflet, fiches
// prestataires) et Google Fonts (Playfair Display) - une CSP par defaut
// casserait les deux. Pas de domaine de stockage d'images externe a ajouter :
// les uploads restent locaux, servis depuis cette meme origine (/uploads,
// imgSrc 'self' suffit) - CLAUDE.md, section Uploads.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https://*.tile.openstreetmap.org'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        connectSrc: ["'self'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : false,
    credentials: true,
  })
);
app.use(express.json());

// Galerie prestataire (photos publiques) — les documents legaux sensibles ne
// transiteront jamais par ce dossier statique (CLAUDE.md, section Uploads).
// Exception : les PDF de factures/contrats (uploads/documents) contiennent
// les donnees personnelles des clients - jamais servis publiquement, seulement
// via GET /api/documents/:filename (authentifie, proprietaire ou admin).
app.use('/uploads/documents', (req, res) => res.status(404).json({ message: 'Document introuvable.' }));
// Noms de fichiers aleatoires (jamais reutilises) : contenu immuable, mis en
// cache 1 an par le navigateur ET le CDN Vercel (s-maxage) - sinon chaque
// image repasse par une fonction serverless a chaque visite.
app.use(
  '/uploads',
  express.static(path.join(__dirname, '../uploads'), {
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
    },
  })
);

// Donnees publiques qui changent rarement : cache CDN court (5 min), servi
// perime pendant la revalidation. GET uniquement, jamais les routes privees.
const publicCache = (req, res, next) => {
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  }
  next();
};

// Verification rapide que l'API repond (racine du domaine).
app.get('/', (req, res) =>
  res.json({
    status: 'ok',
    service: 'Mounesba API',
    // Mode de stockage des fichiers (jamais la cle elle-meme).
    storage: process.env.CLOUDINARY_URL ? 'cloudinary' : 'local',
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/categories', publicCache, categoryRoutes);
app.use('/api/cities', publicCache, cityRoutes);
app.use('/api/listings', listingRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/images', imageRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/packages', packageRoutes);
app.use('/api/availability', availabilityRoutes);
app.use('/api/promotions', promotionRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/favorites', favoriteRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/vehicle_bookings', vehicleBookingRoutes);
app.use('/api/vehicle-decorations', vehicleDecorationRoutes);
app.use('/api/vehicle-options', vehicleOptionRoutes);
app.use('/api/events', providerEventRoutes);
app.use('/api/commissions', commissionRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/documents', documentRoutes);

app.use(errorHandler);

module.exports = app;
