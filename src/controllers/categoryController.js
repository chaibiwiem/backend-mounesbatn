const path = require('path');
const fs = require('fs');
const { validationResult } = require('express-validator');
const db = require('../models');
const { UPLOAD_DIR, ICON_UPLOAD_DIR } = require('../middleware/upload');

const { Category, Listing, AssociatedService } = db;

// Frais de mise en relation (M13) : conditions commerciales Mounesba ->
// prestataire, jamais exposees sur l'API publique.
const FEE_ATTRIBUTES = ['commissionEnabled', 'commissionType', 'commissionValue'];

// Valide et applique les champs de frais : forfait fixe (DT) ou pourcentage
// (1 a 100 %) du contrat, valeur > 0 obligatoire pour activer. Renvoie un
// message d'erreur ou null. Une modification ne vaut que pour les FUTURES
// demandes (tarif fige par ligne).
function applyFeeFields(category, { commissionEnabled, commissionType, commissionValue }) {
  const enabled = commissionEnabled !== undefined ? commissionEnabled : category.commissionEnabled;
  const type = commissionType || category.commissionType || 'fixed';
  const value = commissionValue !== undefined ? commissionValue : category.commissionValue;
  if (enabled && !(Number(value) > 0)) {
    return type === 'percent'
      ? 'Indiquez le taux des frais de mise en relation (en %) pour activer cette catégorie.'
      : 'Indiquez le montant fixe des frais de mise en relation (en DT) pour activer cette catégorie.';
  }
  if (enabled && type === 'percent' && Number(value) > 100) {
    return 'Le taux des frais de mise en relation ne peut pas dépasser 100 %.';
  }
  category.commissionEnabled = Boolean(enabled);
  category.commissionType = enabled ? type : null;
  category.commissionValue = Number(value) > 0 ? value : null;
  return null;
}

exports.getCategories = async (req, res, next) => {
  try {
    const categories = await Category.findAll({
      where: { isActive: true },
      attributes: { exclude: FEE_ATTRIBUTES },
      order: [['sortOrder', 'ASC']],
      include: [
        {
          model: AssociatedService,
          as: 'associatedServices',
          attributes: ['id', 'nameFr', 'nameAr'],
          separate: true,
          order: [['sortOrder', 'ASC']],
        },
      ],
    });

    const byId = {};
    const tree = [];

    categories.forEach((cat) => {
      byId[cat.id] = { ...cat.toJSON(), children: [] };
    });

    categories.forEach((cat) => {
      if (cat.parentId && byId[cat.parentId]) {
        byId[cat.parentId].children.push(byId[cat.id]);
      } else if (!cat.parentId) {
        tree.push(byId[cat.id]);
      }
    });

    return res.json(tree);
  } catch (err) {
    return next(err);
  }
};

// --- Gestion des categories par l'admin (structure de la plateforme) -------

// Arbre complet (actives + inactives), pour l'onglet admin "Categories".
exports.getCategoriesAdmin = async (req, res, next) => {
  try {
    const categories = await Category.findAll({
      order: [['sortOrder', 'ASC']],
      include: [
        {
          model: AssociatedService,
          as: 'associatedServices',
          separate: true,
          order: [['sortOrder', 'ASC']],
        },
      ],
    });

    const byId = {};
    const tree = [];

    categories.forEach((cat) => {
      byId[cat.id] = { ...cat.toJSON(), children: [] };
    });

    categories.forEach((cat) => {
      if (cat.parentId && byId[cat.parentId]) {
        byId[cat.parentId].children.push(byId[cat.id]);
      } else if (!cat.parentId) {
        tree.push(byId[cat.id]);
      }
    });

    return res.json(tree);
  } catch (err) {
    return next(err);
  }
};

exports.createCategory = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { name, slug, icon, parentId, sortOrder, commissionEnabled, commissionType, commissionValue } = req.body;

  try {
    const existingSlug = await Category.findOne({ where: { slug } });
    if (existingSlug) {
      return res.status(409).json({ message: 'Ce slug est déjà utilisé.' });
    }

    if (parentId) {
      const parent = await Category.findByPk(parentId);
      if (!parent) {
        return res.status(400).json({ message: 'Catégorie parente introuvable.' });
      }
      if (parent.parentId) {
        return res.status(400).json({
          message: "Une sous-catégorie ne peut pas être elle-même parente (2 niveaux maximum).",
        });
      }
    }

    const category = Category.build({
      name,
      slug,
      icon: icon || null,
      parentId: parentId || null,
      sortOrder: sortOrder ?? 0,
    });
    const feeError = applyFeeFields(category, { commissionEnabled, commissionType, commissionValue });
    if (feeError) {
      return res.status(400).json({ message: feeError });
    }
    await category.save();

    return res.status(201).json(category);
  } catch (err) {
    return next(err);
  }
};

exports.updateCategory = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { name, slug, icon, parentId, sortOrder, isActive, commissionEnabled, commissionType, commissionValue } =
    req.body;

  try {
    const category = await Category.findByPk(req.params.id);
    if (!category) {
      return res.status(404).json({ message: 'Catégorie introuvable.' });
    }

    if (slug !== undefined && slug !== category.slug) {
      const existingSlug = await Category.findOne({ where: { slug } });
      if (existingSlug) {
        return res.status(409).json({ message: 'Ce slug est déjà utilisé.' });
      }
    }

    if (parentId !== undefined && parentId !== null) {
      if (parentId === category.id) {
        return res.status(400).json({ message: 'Une catégorie ne peut pas être sa propre parente.' });
      }
      const parent = await Category.findByPk(parentId);
      if (!parent) {
        return res.status(400).json({ message: 'Catégorie parente introuvable.' });
      }
      if (parent.parentId) {
        return res.status(400).json({
          message: "Une sous-catégorie ne peut pas être elle-même parente (2 niveaux maximum).",
        });
      }
    }

    if (name !== undefined) category.name = name;
    if (slug !== undefined) category.slug = slug;
    if (icon !== undefined) category.icon = icon || null;
    if (parentId !== undefined) category.parentId = parentId || null;
    if (sortOrder !== undefined) category.sortOrder = sortOrder;
    if (isActive !== undefined) category.isActive = isActive;
    if (commissionEnabled !== undefined || commissionType !== undefined || commissionValue !== undefined) {
      const feeError = applyFeeFields(category, { commissionEnabled, commissionType, commissionValue });
      if (feeError) {
        return res.status(400).json({ message: feeError });
      }
    }
    await category.save();

    return res.json(category);
  } catch (err) {
    return next(err);
  }
};

// Supprime l'ancien fichier image stocke sur disque, le cas echeant (meme
// pipeline que le logo prestataire - listingController.removeLogoFile).
function removeCategoryImageFile(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith('/uploads/listings/')) return;
  const filePath = path.join(UPLOAD_DIR, path.basename(imageUrl));
  fs.unlink(filePath, () => {});
}

// Image de vignette pour une categorie/sous-categorie (page d'accueil),
// distincte de l'icone. Meme pipeline de verification que les photos de
// fiche (magic bytes JPG/PNG, 5 Mo max - CLAUDE.md Uploads).
exports.uploadCategoryImage = async (req, res, next) => {
  try {
    const category = await Category.findByPk(req.params.id);
    if (!category) {
      return res.status(404).json({ message: 'Catégorie introuvable.' });
    }

    const previousImageUrl = category.imageUrl;
    category.imageUrl = req.uploadedFile.url;
    await category.save();
    removeCategoryImageFile(previousImageUrl);

    return res.json(category);
  } catch (err) {
    return next(err);
  }
};

exports.deleteCategoryImage = async (req, res, next) => {
  try {
    const category = await Category.findByPk(req.params.id);
    if (!category) {
      return res.status(404).json({ message: 'Catégorie introuvable.' });
    }

    removeCategoryImageFile(category.imageUrl);
    category.imageUrl = null;
    await category.save();

    return res.json(category);
  } catch (err) {
    return next(err);
  }
};

// Icone SVG de la categorie (affichee dans les menus/listes de categories,
// distincte de l'image de vignette ci-dessus). Le fichier a deja ete assaini
// et ecrit sur disque par persistVerifiedIcon avant d'arriver ici.
function removeCategoryIconFile(iconUrl) {
  if (!iconUrl || !iconUrl.startsWith('/uploads/icons/')) return;
  const filePath = path.join(ICON_UPLOAD_DIR, path.basename(iconUrl));
  fs.unlink(filePath, () => {});
}

exports.uploadCategoryIcon = async (req, res, next) => {
  try {
    const category = await Category.findByPk(req.params.id);
    if (!category) {
      return res.status(404).json({ message: 'Catégorie introuvable.' });
    }

    const previousIconUrl = category.iconUrl;
    category.iconUrl = req.uploadedFile.url;
    await category.save();
    removeCategoryIconFile(previousIconUrl);

    return res.json(category);
  } catch (err) {
    return next(err);
  }
};

exports.deleteCategoryIcon = async (req, res, next) => {
  try {
    const category = await Category.findByPk(req.params.id);
    if (!category) {
      return res.status(404).json({ message: 'Catégorie introuvable.' });
    }

    removeCategoryIconFile(category.iconUrl);
    category.iconUrl = null;
    await category.save();

    return res.json(category);
  } catch (err) {
    return next(err);
  }
};

// --- Services associes (liste informative FR/AR par categorie principale) --

exports.createAssociatedService = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { categoryId } = req.params;
  const { nameFr, nameAr, sortOrder } = req.body;

  try {
    const category = await Category.findByPk(categoryId);
    if (!category) {
      return res.status(404).json({ message: 'Catégorie introuvable.' });
    }

    const service = await AssociatedService.create({
      categoryId,
      nameFr,
      nameAr: nameAr || null,
      sortOrder: sortOrder ?? 0,
    });

    return res.status(201).json(service);
  } catch (err) {
    return next(err);
  }
};

exports.updateAssociatedService = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { nameFr, nameAr, sortOrder } = req.body;

  try {
    const service = await AssociatedService.findByPk(req.params.id);
    if (!service) {
      return res.status(404).json({ message: 'Service introuvable.' });
    }

    if (nameFr !== undefined) service.nameFr = nameFr;
    if (nameAr !== undefined) service.nameAr = nameAr || null;
    if (sortOrder !== undefined) service.sortOrder = sortOrder;
    await service.save();

    return res.json(service);
  } catch (err) {
    return next(err);
  }
};

exports.deleteAssociatedService = async (req, res, next) => {
  try {
    const service = await AssociatedService.findByPk(req.params.id);
    if (!service) {
      return res.status(404).json({ message: 'Service introuvable.' });
    }

    await service.destroy();
    return res.json({ message: 'Service supprimé.' });
  } catch (err) {
    return next(err);
  }
};

exports.deleteCategory = async (req, res, next) => {
  try {
    const category = await Category.findByPk(req.params.id);
    if (!category) {
      return res.status(404).json({ message: 'Catégorie introuvable.' });
    }

    const childrenCount = await Category.count({ where: { parentId: category.id } });
    if (childrenCount > 0) {
      return res.status(409).json({
        message: 'Supprimez ou déplacez d’abord les sous-catégories de cette catégorie.',
      });
    }

    const listingsCount = await Listing.count({ where: { categoryId: category.id } });
    if (listingsCount > 0) {
      return res.status(409).json({
        message: 'Des prestataires utilisent cette catégorie : impossible de la supprimer.',
      });
    }

    await category.destroy();
    return res.json({ message: 'Catégorie supprimée.' });
  } catch (err) {
    return next(err);
  }
};
