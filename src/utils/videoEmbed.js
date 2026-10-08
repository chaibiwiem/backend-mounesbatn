// Convertit un lien YouTube/Vimeo public en URL embarquable (iframe) et,
// quand c'est possible sans appel API externe, en URL de vignette. Aucun
// hebergement/traitement video cote plateforme (CLAUDE.md).
function parseVideoUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./, '');

  const youtubeResult = (videoId) =>
    videoId
      ? {
          embedUrl: `https://www.youtube.com/embed/${videoId}`,
          // Vignette generee automatiquement par YouTube, pas d'appel API requis.
          thumbnailUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
        }
      : null;

  if (host === 'youtube.com' || host === 'm.youtube.com') {
    if (parsed.pathname === '/watch') {
      return youtubeResult(parsed.searchParams.get('v'));
    }
    const embedMatch = parsed.pathname.match(/^\/embed\/([\w-]+)/);
    return embedMatch ? youtubeResult(embedMatch[1]) : null;
  }

  if (host === 'youtu.be') {
    return youtubeResult(parsed.pathname.slice(1));
  }

  if (host === 'vimeo.com') {
    const videoId = parsed.pathname.match(/^\/(\d+)/)?.[1];
    // Pas de vignette Vimeo sans appel a leur API oEmbed : le frontend affiche
    // un visuel generique + bouton play dans ce cas.
    return videoId
      ? { embedUrl: `https://player.vimeo.com/video/${videoId}`, thumbnailUrl: null }
      : null;
  }

  if (host === 'player.vimeo.com') {
    const videoId = parsed.pathname.match(/^\/video\/(\d+)/)?.[1];
    return videoId
      ? { embedUrl: `https://player.vimeo.com/video/${videoId}`, thumbnailUrl: null }
      : null;
  }

  return null;
}

module.exports = { parseVideoUrl };
