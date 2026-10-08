// Assainissement d'un fichier SVG televerse (icone de categorie, admin
// uniquement). Exception ciblee et documentee a la regle CLAUDE.md "Uploads :
// JPG/PNG uniquement" - un SVG n'a pas de signature binaire (magic bytes) a
// verifier, et peut embarquer du JS ou des references externes, d'ou ce
// nettoyage avant stockage. Le fichier assaini n'est jamais affiche autrement
// qu'en <img src="..."> cote frontend (jamais dangerouslySetInnerHTML), ce
// qui empeche deja l'execution d'un script residuel ; ce nettoyage retire en
// plus tout ce qui pourrait s'executer si le fichier etait ouvert autrement
// (navigation directe sur l'URL, <object>, <iframe>...).
//
// Approche par expressions regulieres (pas de parseur XML/DOM cote serveur) :
// suffisant ici car la source est un admin authentifie (pas un upload public
// anonyme), en defense en profondeur avec la restriction de role sur la route.

const MAX_SVG_SIZE = 100 * 1024; // 100 Ko - une icone n'a pas besoin de plus

function looksLikeSvg(text) {
  const trimmed = text.trimStart();
  return /^(<\?xml[^>]*\?>\s*)?(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(trimmed);
}

function sanitizeSvg(buffer) {
  if (!buffer || buffer.length === 0 || buffer.length > MAX_SVG_SIZE) return null;

  let text = buffer.toString('utf8');
  if (!looksLikeSvg(text)) return null;

  // Declarations DOCTYPE/ENTITY : retirees entierement (risque d'injection
  // d'entites externes, cf. XXE).
  text = text.replace(/<!DOCTYPE[^>]*(\[[^\]]*\])?[^>]*>/gi, '');
  text = text.replace(/<!ENTITY[^>]*>/gi, '');

  // Balises executables ou capables d'embarquer du HTML/JS arbitraire.
  const DANGEROUS_TAGS = ['script', 'foreignObject', 'iframe', 'embed', 'object', 'link', 'meta'];
  for (const tag of DANGEROUS_TAGS) {
    text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '');
    text = text.replace(new RegExp(`<${tag}[^>]*/?>`, 'gi'), '');
  }

  // Gestionnaires d'evenements (onload, onclick...) sur n'importe quel element.
  text = text.replace(/\son\w+\s*=\s*"(?:[^"\\]|\\.)*"/gi, '');
  text = text.replace(/\son\w+\s*=\s*'(?:[^'\\]|\\.)*'/gi, '');

  // Attributs pointant vers du code executable (javascript:) ou du HTML
  // encode (data:text/html) - href/xlink:href/src.
  text = text.replace(
    /\s(?:xlink:href|href|src)\s*=\s*"(?:\s*javascript:|\s*data:text\/html)[^"]*"/gi,
    ''
  );
  text = text.replace(
    /\s(?:xlink:href|href|src)\s*=\s*'(?:\s*javascript:|\s*data:text\/html)[^']*'/gi,
    ''
  );

  if (!looksLikeSvg(text) || /<script/i.test(text)) return null;

  return Buffer.from(text, 'utf8');
}

module.exports = { sanitizeSvg, MAX_SVG_SIZE };
