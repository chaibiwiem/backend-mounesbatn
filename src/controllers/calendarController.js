const { Op } = require('sequelize');
const db = require('../models');

const { Listing, Booking, Client, Availability } = db;

// Vue calendrier des reservations (M5) : bookings + availability d'une
// periode donnee en un seul appel, pour alimenter les vues Jour/Semaine/Mois
// du prestataire sans jamais charger l'historique complet d'un coup. Aucune
// nouvelle table - reutilise bookings/availability telles quelles (voir
// CLAUDE.md, "modele lead" - ces reservations restent declaratives, aucun
// paiement traite par la plateforme).
exports.getCalendar = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({ message: 'Paramètres from et to requis (YYYY-MM-DD).' });
    }

    const listing = await Listing.findByPk(id);
    if (!listing) {
      return res.status(404).json({ message: 'Prestataire introuvable.' });
    }
    // Meme regle d'acces que les autres endpoints de gestion M5 (leads,
    // bookings, clients...) : prestataire proprietaire de la fiche, ou admin.
    if (listing.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    const bookings = await Booking.findAll({
      where: { listingId: id, eventDate: { [Op.between]: [from, to] } },
      include: [{ model: Client, as: 'client', attributes: ['id', 'name', 'phone', 'email'] }],
      order: [['eventDate', 'ASC'], ['startTime', 'ASC']],
    });

    // Entrees manuelles uniquement (pas de fusion avec les bookings ici,
    // contrairement a availabilityController.getAvailability) : les
    // reservations sont deja renvoyees separement ci-dessus, une fusion
    // ferait apparaitre un double bloc (reservation + "Indisponible") pour
    // la meme date.
    const availability = await Availability.findAll({
      where: { listingId: id, date: { [Op.between]: [from, to] } },
      order: [['date', 'ASC']],
    });

    return res.json({ bookings, availability });
  } catch (err) {
    return next(err);
  }
};
