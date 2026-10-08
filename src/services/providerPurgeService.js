const { Op } = require('sequelize');
const db = require('../models');
const { LEGAL_FOLDER } = require('../middleware/upload');
const { deleteStoredFile, deletePrivateFile } = require('./storageService');

// Suppression DEFINITIVE d'une fiche prestataire et de TOUT ce qui en depend
// (demandes, avis, reservations, clients CRM, contrats, factures, frais de
// mise en relation, vehicules, medias...), declenchee manuellement par un
// Super Admin depuis l'onglet "Supprimés" avec confirmation par saisie du nom
// de la fiche. Irreversible : les factures et contrats sont eux aussi
// supprimes - c'est a l'admin de conserver ses archives comptables.


const ids = (rows) => rows.map((row) => row.id);

// Inventaire de ce qui serait supprime (affiche dans la fenetre de
// confirmation avant toute action).
async function previewPurge(listing) {
  const where = { where: { listingId: listing.id } };
  const [leads, reviews, bookings, vehicleBookings, contracts, invoices, clients, disputes, otherListings] =
    await Promise.all([
      db.Lead.count(where),
      db.Review.count(where),
      db.Booking.count(where),
      db.VehicleBooking.count(where),
      db.Contract.count(where),
      db.Invoice.count(where),
      db.Client.count(where),
      db.Dispute.count(where),
      db.Listing.count({ where: { userId: listing.userId, id: { [Op.ne]: listing.id } }, paranoid: false }),
    ]);
  return {
    counts: { leads, reviews, bookings, vehicleBookings, contracts, invoices, clients, disputes },
    ownerHasOtherListings: otherListings > 0,
  };
}

// URLs des fichiers references par les lignes supprimees (photos, videos,
// PDF... en local ou sur Cloudinary) - supprimes APRES le commit, en best
// effort (deleteStoredFile ignore toute URL externe).
function collectUploadFiles(rows, fields) {
  const files = [];
  rows.forEach((row) => {
    fields.forEach((field) => {
      if (typeof row[field] === 'string') files.push(row[field]);
    });
  });
  return files;
}

async function purgeListing(listing, { deleteOwnerAccount = false } = {}) {
  const files = [];
  const listingId = listing.id;
  const byListing = { where: { listingId } };

  const cinDocumentRef = listing.cinDocumentUrl;

  await db.sequelize.transaction(async (transaction) => {
    const opts = { transaction };
    const whereIn = (field, values) => ({ where: { [field]: values }, transaction });

    const [leads, bookings, reviews, vehicles, images, videos, contracts, invoices, events, commissionInvoices] =
      await Promise.all([
        db.Lead.findAll({ ...byListing, attributes: ['id'], ...opts }),
        db.Booking.findAll({ ...byListing, attributes: ['id'], ...opts }),
        db.Review.findAll({ ...byListing, attributes: ['id'], ...opts }),
        db.Vehicle.findAll({ ...byListing, ...opts }),
        db.Image.findAll({ ...byListing, ...opts }),
        db.Video.findAll({ ...byListing, ...opts }),
        db.Contract.findAll({ ...byListing, ...opts }),
        db.Invoice.findAll({ ...byListing, ...opts }),
        db.ProviderEvent.findAll({ ...byListing, ...opts }),
        db.CommissionInvoice.findAll({ ...byListing, ...opts }),
      ]);
    const leadIds = ids(leads);
    const reviewIds = ids(reviews);
    const vehicleIds = ids(vehicles);

    const reviewPhotos = reviewIds.length ? await db.ReviewPhoto.findAll(whereIn('reviewId', reviewIds)) : [];
    const decorations = vehicleIds.length ? await db.VehicleDecoration.findAll(whereIn('vehicleId', vehicleIds)) : [];

    files.push(
      ...collectUploadFiles(images, ['url']),
      ...collectUploadFiles(videos, ['url', 'thumbnailUrl']),
      ...collectUploadFiles(reviewPhotos, ['url']),
      ...collectUploadFiles(vehicles, ['imageUrl']),
      ...collectUploadFiles(decorations, ['imageUrl']),
      ...collectUploadFiles(events, ['imageUrl']),
      ...collectUploadFiles(contracts, ['pdfUrl']),
      ...collectUploadFiles(invoices, ['pdfUrl']),
      ...collectUploadFiles(commissionInvoices, ['pdfUrl']),
      ...collectUploadFiles([listing], ['logoUrl'])
    );

    // Ordre : enfants avant parents (contraintes de cles etrangeres).
    if (reviewIds.length) await db.ReviewPhoto.destroy(whereIn('reviewId', reviewIds));
    await db.Dispute.destroy({
      where: { [Op.or]: [{ listingId }, ...(reviewIds.length ? [{ reviewId: reviewIds }] : [])] },
      transaction,
    });
    await db.Review.destroy({ ...byListing, ...opts });

    await db.Commission.destroy({
      where: { [Op.or]: [{ listingId }, ...(leadIds.length ? [{ leadId: leadIds }] : [])] },
      transaction,
    });
    await db.CommissionInvoice.destroy({ ...byListing, ...opts });

    if (leadIds.length) await db.LeadOption.destroy(whereIn('leadId', leadIds));
    await db.Invoice.destroy({ ...byListing, ...opts });
    await db.Contract.destroy({ ...byListing, ...opts });
    await db.VehicleBooking.destroy({
      where: { [Op.or]: [{ listingId }, ...(vehicleIds.length ? [{ vehicleId: vehicleIds }] : [])] },
      transaction,
    });
    await db.Booking.destroy({ ...byListing, ...opts });
    await db.Lead.destroy({ ...byListing, ...opts });

    if (vehicleIds.length) {
      await db.VehicleOption.destroy(whereIn('vehicleId', vehicleIds));
      await db.VehicleDecoration.destroy(whereIn('vehicleId', vehicleIds));
    }
    await db.Vehicle.destroy({ ...byListing, ...opts });
    await db.Client.destroy({ ...byListing, ...opts });

    await Promise.all(
      [db.Image, db.Video, db.Package, db.Promotion, db.Availability, db.Favorite, db.ProviderEvent, db.ListingCategory].map(
        (Model) => Model.destroy({ ...byListing, ...opts })
      )
    );

    await listing.destroy({ force: true, transaction });

    // Compte du gerant (optionnel) : seulement s'il n'a aucune autre fiche.
    if (deleteOwnerAccount) {
      const otherListings = await db.Listing.count({ where: { userId: listing.userId }, paranoid: false, transaction });
      if (otherListings === 0) {
        const userId = listing.userId;
        const subscriptions = await db.Subscription.findAll({ where: { userId }, transaction });
        const subscriptionIds = ids(subscriptions);
        if (subscriptionIds.length) {
          const subscriptionInvoices = await db.SubscriptionInvoice.findAll(whereIn('subscriptionId', subscriptionIds));
          files.push(...collectUploadFiles(subscriptionInvoices, ['pdfUrl']));
          await db.SubscriptionInvoice.destroy(whereIn('subscriptionId', subscriptionIds));
        }
        await db.Subscription.destroy({ where: { userId }, transaction });
        await db.Favorite.destroy({ where: { userId }, transaction });
        await db.Dispute.destroy({ where: { reporterId: userId }, transaction });
        // References facultatives vers ce compte ailleurs (ex. demandes qu'il
        // aurait faites en tant que client chez un autre prestataire).
        await Promise.all(
          [db.Lead, db.Booking, db.Review, db.Client].map((Model) =>
            Model.update({ userId: null }, { where: { userId }, transaction })
          )
        );
        await db.User.destroy({ where: { id: userId }, transaction });
      }
    }
  });

  files.forEach(deleteStoredFile);
  deletePrivateFile(cinDocumentRef, LEGAL_FOLDER);
}

module.exports = { previewPurge, purgeListing };
