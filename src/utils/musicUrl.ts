export type MusicProvider = 'spotify' | 'youtube';

export interface ValidatedMusicEmbed {
  ok: true;
  provider: MusicProvider;
  embedUrl: string;
  canonicalUrl: string;
  label: string;
  compactHeight: number;
}

export interface InvalidMusicEmbed {
  ok: false;
  error: string;
}

export type MusicEmbedValidation = ValidatedMusicEmbed | InvalidMusicEmbed;

const SAFE_ID_REGEX = /^[A-Za-z0-9_-]{6,64}$/;
const SPOTIFY_ID_REGEX = /^[A-Za-z0-9]{10,40}$/;

const SPOTIFY_KINDS = new Set(['track', 'album', 'playlist', 'episode', 'show']);

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
]);

export function validateAndBuildMusicEmbed(rawInput: string): MusicEmbedValidation {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { ok: false, error: 'Paste an HTTPS Spotify or YouTube URL.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      error: 'Enter a full URL starting with https:// (for example, open.spotify.com or youtube.com).',
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: 'Only secure https:// links from Spotify or YouTube are allowed.',
    };
  }

  const host = parsed.hostname.toLowerCase();

  if (host === 'open.spotify.com') {
    const segments = parsed.pathname.split('/').filter(Boolean);
    // Optional locale prefix like /intl-en/track/<id>
    const normalized =
      segments[0]?.startsWith('intl-') && segments.length >= 3 ? segments.slice(1) : segments;

    // Support /embed/<kind>/<id> or /<kind>/<id>
    const kindIdx = normalized[0] === 'embed' ? 1 : 0;
    const kind = normalized[kindIdx];
    const id = normalized[kindIdx + 1];

    if (!kind || !id || !SPOTIFY_KINDS.has(kind) || !SPOTIFY_ID_REGEX.test(id)) {
      return {
        ok: false,
        error: 'Supported Spotify links: track, playlist, album, episode, or show URLs from open.spotify.com.',
      };
    }

    const compactHeight = kind === 'track' || kind === 'episode' ? 152 : 352;
    return {
      ok: true,
      provider: 'spotify',
      embedUrl: `https://open.spotify.com/embed/${kind}/${id}?utm_source=generator`,
      canonicalUrl: `https://open.spotify.com/${kind}/${id}`,
      label: `Spotify ${kind}`,
      compactHeight,
    };
  }

  if (YOUTUBE_HOSTS.has(host)) {
    const segments = parsed.pathname.split('/').filter(Boolean);

    if (host === 'youtu.be') {
      const videoId = segments[0];
      if (!videoId || !SAFE_ID_REGEX.test(videoId)) {
        return { ok: false, error: 'Invalid youtu.be video link.' };
      }
      return {
        ok: true,
        provider: 'youtube',
        embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
        canonicalUrl: `https://youtu.be/${videoId}`,
        label: 'YouTube video',
        compactHeight: 200,
      };
    }

    // Playlist URL: /playlist?list=...
    const listParam = parsed.searchParams.get('list');
    const vParam = parsed.searchParams.get('v');

    if (parsed.pathname === '/watch' && vParam && SAFE_ID_REGEX.test(vParam)) {
      const playlistSuffix =
        listParam && SAFE_ID_REGEX.test(listParam) ? `?list=${encodeURIComponent(listParam)}` : '';
      return {
        ok: true,
        provider: 'youtube',
        embedUrl: `https://www.youtube-nocookie.com/embed/${vParam}${playlistSuffix}`,
        canonicalUrl: `https://www.youtube.com/watch?v=${vParam}${playlistSuffix}`,
        label: listParam ? 'YouTube playlist' : 'YouTube video',
        compactHeight: 200,
      };
    }

    if (parsed.pathname === '/playlist' && listParam && SAFE_ID_REGEX.test(listParam)) {
      return {
        ok: true,
        provider: 'youtube',
        embedUrl: `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(listParam)}`,
        canonicalUrl: `https://www.youtube.com/playlist?list=${listParam}`,
        label: 'YouTube playlist',
        compactHeight: 200,
      };
    }

    if (
      (segments[0] === 'live' || segments[0] === 'shorts' || segments[0] === 'embed') &&
      segments[1] &&
      SAFE_ID_REGEX.test(segments[1])
    ) {
      const videoId = segments[1];
      return {
        ok: true,
        provider: 'youtube',
        embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
        canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
        label: 'YouTube stream',
        compactHeight: 200,
      };
    }

    return {
      ok: false,
      error: 'Paste a YouTube watch, playlist, live stream, or youtu.be link.',
    };
  }

  return {
    ok: false,
    error: 'Only official Spotify (open.spotify.com) and YouTube (youtube.com / youtu.be) links are supported.',
  };
}
