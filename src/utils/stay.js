// Outils partages pour les sejours "Maison d'hote" (Arrivee/Depart +
// chambres), reutilises par les demandes (Lead), reservations (Booking),
// factures (PDF) et le calendrier des disponibilites.

// Nuits couvertes par un sejour [arrivee, depart[ - le jour de depart lui-meme
// n'est pas occupe (le client part le matin, un autre peut arriver le jour meme).
function stayNights(checkInDate, checkOutDate) {
  const nights = [];
  if (!checkInDate || !checkOutDate) return nights;
  const cursor = new Date(`${checkInDate}T00:00:00Z`);
  const end = new Date(`${checkOutDate}T00:00:00Z`);
  while (cursor < end) {
    nights.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return nights;
}

// MariaDB renvoie DataTypes.JSON sous forme de chaine (LONGTEXT) : getter
// defensif, meme principe que jsonColumnGetter (models/Listing.js).
function jsonColumnGetter(field) {
  return function get() {
    const raw = this.getDataValue(field);
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
}

const round2 = (value) => Math.round(value * 100) / 100;

// Normalise un tableau de chambres (entiers >= 0, au moins un adulte par
// chambre garanti par les validateurs des routes). `price` : prix par nuit de
// la chambre, saisi par le prestataire sur une reservation (jamais par le
// client dans une demande) - conserve seulement s'il est positif.
function normalizeRooms(rooms) {
  if (!Array.isArray(rooms) || rooms.length === 0) return null;
  return rooms.map((room) => {
    const normalized = {
      adults: Math.max(1, Number(room?.adults) || 1),
      children: Math.max(0, Number(room?.children) || 0),
      babies: Math.max(0, Number(room?.babies) || 0),
    };
    const price = Number(room?.price);
    if (Number.isFinite(price) && price > 0) normalized.price = round2(price);
    return normalized;
  });
}

// Montant d'une reservation (toutes categories) : chambres (prix/nuit x
// nuits, sejour "Maison d'hote") + prix de la prestation + pack - remise
// (montant en DT ou pourcentage, plafonnee au sous-total). null si aucun
// prix n'est renseigne : le montant reste alors saisi manuellement.
// Meme calcul cote frontend (frontend/src/utils/stay.js).
function computeBookingTotal({
  rooms,
  checkInDate,
  checkOutDate,
  servicePrice,
  packagePrice,
  discountType,
  discountValue,
}) {
  const pricedRooms = Array.isArray(rooms) ? rooms : [];
  const nights = stayNights(checkInDate, checkOutDate).length;
  const perNight = round2(pricedRooms.reduce((sum, room) => sum + (Number(room?.price) || 0), 0));
  const roomsAmount = round2(perNight * nights);
  const serviceAmount = round2(Math.max(0, Number(servicePrice) || 0));
  const packAmount = round2(Math.max(0, Number(packagePrice) || 0));
  const subtotal = round2(roomsAmount + serviceAmount + packAmount);
  if (!(perNight > 0) && !(serviceAmount > 0) && !(packAmount > 0)) return null;
  const value = Math.max(0, Number(discountValue) || 0);
  const discountAmount = round2(
    Math.min(subtotal, discountType === 'percent' ? (subtotal * Math.min(value, 100)) / 100 : value)
  );
  return {
    nights,
    perNight,
    roomsAmount,
    serviceAmount,
    packAmount,
    subtotal,
    discountAmount,
    total: round2(subtotal - discountAmount),
  };
}

// "2 chambres : 4 adultes, 1 enfant, 1 lit bébé"
function roomsSummary(rooms) {
  if (!Array.isArray(rooms) || rooms.length === 0) return '';
  const total = rooms.reduce(
    (acc, room) => ({
      adults: acc.adults + Number(room.adults || 0),
      children: acc.children + Number(room.children || 0),
      babies: acc.babies + Number(room.babies || 0),
    }),
    { adults: 0, children: 0, babies: 0 }
  );
  const parts = [`${total.adults} adulte${total.adults > 1 ? 's' : ''}`];
  if (total.children > 0) parts.push(`${total.children} enfant${total.children > 1 ? 's' : ''}`);
  if (total.babies > 0) parts.push(`${total.babies} lit${total.babies > 1 ? 's' : ''} bébé`);
  return `${rooms.length} chambre${rooms.length > 1 ? 's' : ''} : ${parts.join(', ')}`;
}

function formatFrDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = String(dateStr).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

// "Séjour du 12/10/2026 au 15/10/2026 (3 nuits)"
function staySummary(checkInDate, checkOutDate) {
  if (!checkInDate || !checkOutDate) return '';
  const nights = stayNights(checkInDate, checkOutDate).length;
  return `Séjour du ${formatFrDate(checkInDate)} au ${formatFrDate(checkOutDate)} (${nights} nuit${
    nights > 1 ? 's' : ''
  })`;
}

module.exports = {
  stayNights,
  jsonColumnGetter,
  normalizeRooms,
  computeBookingTotal,
  roomsSummary,
  staySummary,
  formatFrDate,
};
