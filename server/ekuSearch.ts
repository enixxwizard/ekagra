import type {
  EkuResourceItem,
  EkuResourceLanguageNotice,
  EkuResourceType,
} from '../src/types/eku';

const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^\[?::1\]?$/,
  /^\[?fc/i,
  /^\[?fd/i,
  /^\[?fe80:/i,
  /\.local$/i,
  /\.internal$/i,
];

const SPAM_DOMAINS = [
  'pinterest.',
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'quora.com',
  'coursehero.com',
  'chegg.com',
  'scribd.com',
];

const OFFICIAL_DOC_HOSTS = [
  'developer.mozilla.org',
  'docs.python.org',
  'docs.oracle.com',
  'dev.mysql.com',
  'postgresql.org',
  'react.dev',
  'typescriptlang.org',
  'nodejs.org',
  'learn.microsoft.com',
  'go.dev',
  'doc.rust-lang.org',
  'docs.spring.io',
  'kotlinlang.org',
];

const UNIVERSITY_DOMAINS = [
  '.edu',
  '.ac.in',
  '.ac.uk',
  'nptel.ac.in',
  'ocw.mit.edu',
  'cs.stanford.edu',
  'web.stanford.edu',
  'inst.eecs.berkeley.edu',
];

const EDUCATIONAL_SITES = [
  'geeksforgeeks.org',
  'javatpoint.com',
  'tutorialspoint.com',
  'w3schools.com',
  'khanacademy.org',
  'freecodecamp.org',
  'programiz.com',
  'baeldung.com',
  'cp-algorithms.com',
  'brilliant.org',
  'wikipedia.org',
  'libretexts.org',
  'openstax.org',
];

const LANGUAGE_NORMALIZATION: Record<string, { label: string; isoCode: string; keywords: string[] }> = {
  english: { label: 'English', isoCode: 'en', keywords: ['english', 'in english'] },
  tamil: { label: 'Tamil', isoCode: 'ta', keywords: ['tamil', 'தமிழ்', 'tanglish'] },
  hindi: { label: 'Hindi', isoCode: 'hi', keywords: ['hindi', 'हिन्दी', 'हिंदी'] },
  telugu: { label: 'Telugu', isoCode: 'te', keywords: ['telugu', 'తెలుగు'] },
  malayalam: { label: 'Malayalam', isoCode: 'ml', keywords: ['malayalam', 'മലയാളം'] },
  kannada: { label: 'Kannada', isoCode: 'kn', keywords: ['kannada', 'ಕನ್ನಡ'] },
  bengali: { label: 'Bengali', isoCode: 'bn', keywords: ['bengali', 'bangla', 'বাংলা'] },
  marathi: { label: 'Marathi', isoCode: 'mr', keywords: ['marathi', 'मराठी'] },
  spanish: { label: 'Spanish', isoCode: 'es', keywords: ['spanish', 'español'] },
  french: { label: 'French', isoCode: 'fr', keywords: ['french', 'français'] },
  german: { label: 'German', isoCode: 'de', keywords: ['german', 'deutsch'] },
  japanese: { label: 'Japanese', isoCode: 'ja', keywords: ['japanese', '日本語'] },
};

export function normalizeLanguageName(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const lower = raw.trim().toLowerCase();
  for (const [key, cfg] of Object.entries(LANGUAGE_NORMALIZATION)) {
    if (key === lower || cfg.label.toLowerCase() === lower || cfg.isoCode === lower) {
      return cfg.label;
    }
  }
  const clean = raw.trim().slice(0, 32);
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function getLanguageConfig(langLabel: string): { label: string; isoCode: string; keywords: string[] } {
  const lower = langLabel.trim().toLowerCase();
  return (
    LANGUAGE_NORMALIZATION[lower] ?? {
      label: langLabel,
      isoCode: lower.slice(0, 2),
      keywords: [lower],
    }
  );
}

export function isSafeExternalHttpsUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname || !hostname.includes('.')) return null;
    if (BLOCKED_HOSTNAME_PATTERNS.some((re) => re.test(hostname))) return null;
    return parsed;
  } catch {
    return null;
  }
}

interface VerifiedUrlCheck {
  ok: boolean;
  finalUrl: string;
  contentType: string;
}

async function verifyUrlReachable(rawUrl: string): Promise<VerifiedUrlCheck> {
  const initial = isSafeExternalHttpsUrl(rawUrl);
  if (!initial) return { ok: false, finalUrl: rawUrl, contentType: '' };

  let currentUrl = initial.toString();
  for (let hop = 0; hop < 3; hop++) {
    const safeUrl = isSafeExternalHttpsUrl(currentUrl);
    if (!safeUrl) return { ok: false, finalUrl: rawUrl, contentType: '' };

    try {
      const headRes = await fetch(safeUrl.toString(), {
        method: 'HEAD',
        redirect: 'manual',
        headers: { 'User-Agent': 'EkagraStudyAssistant/1.0' },
        signal: AbortSignal.timeout(3200),
      });

      if (headRes.status >= 300 && headRes.status < 400) {
        const loc = headRes.headers.get('location');
        if (!loc) return { ok: false, finalUrl: safeUrl.toString(), contentType: '' };
        currentUrl = new URL(loc, safeUrl).toString();
        continue;
      }

      if (headRes.ok) {
        return {
          ok: true,
          finalUrl: safeUrl.toString(),
          contentType: (headRes.headers.get('content-type') || '').toLowerCase(),
        };
      }

      // Some educational hosts reject HEAD with 403/405 but allow partial GET
      if (headRes.status === 403 || headRes.status === 405) {
        const getRes = await fetch(safeUrl.toString(), {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'User-Agent': 'EkagraStudyAssistant/1.0',
            Range: 'bytes=0-255',
          },
          signal: AbortSignal.timeout(3200),
        });
        if (getRes.status >= 300 && getRes.status < 400) {
          const loc = getRes.headers.get('location');
          if (!loc) return { ok: false, finalUrl: safeUrl.toString(), contentType: '' };
          currentUrl = new URL(loc, safeUrl).toString();
          continue;
        }
        return {
          ok: getRes.ok || getRes.status === 206,
          finalUrl: safeUrl.toString(),
          contentType: (getRes.headers.get('content-type') || '').toLowerCase(),
        };
      }

      return { ok: false, finalUrl: safeUrl.toString(), contentType: '' };
    } catch {
      return { ok: false, finalUrl: safeUrl.toString(), contentType: '' };
    }
  }

  return { ok: false, finalUrl: rawUrl, contentType: '' };
}

function classifyWebResource(
  urlStr: string,
  title: string,
  snippet: string,
  contentType: string
): EkuResourceType {
  const lowerUrl = urlStr.toLowerCase();
  const parsed = isSafeExternalHttpsUrl(urlStr);
  const host = parsed?.hostname.toLowerCase() ?? '';

  if (host.includes('youtube.com') || host.includes('youtu.be')) {
    return 'youtube_video';
  }
  if (contentType.includes('application/pdf') || /\.pdf($|\?)/i.test(lowerUrl)) {
    return 'direct_pdf';
  }
  if (
    lowerUrl.includes('pdf') ||
    /\bpdf\b/i.test(title) ||
    /download.*pdf|lecture.*notes.*pdf/i.test(snippet)
  ) {
    return 'pdf_host_page';
  }
  if (OFFICIAL_DOC_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) {
    return 'official_docs';
  }
  if (UNIVERSITY_DOMAINS.some((d) => host.endsWith(d) || host.includes(d))) {
    return 'university_notes';
  }
  return 'educational_site';
}

function scoreResourceTrust(urlStr: string, resourceType: EkuResourceType): number {
  const parsed = isSafeExternalHttpsUrl(urlStr);
  if (!parsed) return -100;
  const host = parsed.hostname.toLowerCase();
  if (SPAM_DOMAINS.some((d) => host.includes(d))) return -50;

  let score = 0;
  if (resourceType === 'official_docs') score += 5;
  if (resourceType === 'university_notes') score += 4;
  if (resourceType === 'direct_pdf') score += 4;
  if (resourceType === 'youtube_video') score += 3;
  if (EDUCATIONAL_SITES.some((s) => host === s || host.endsWith(`.${s}`))) score += 3;
  return score;
}

function matchesNonEnglishLanguageHint(
  text: string,
  langLabel: string
): boolean {
  if (langLabel.toLowerCase() === 'english') return true;
  const cfg = getLanguageConfig(langLabel);
  const lower = text.toLowerCase();
  return cfg.keywords.some((kw) => lower.includes(kw));
}

async function searchTavily(
  query: string,
  apiKey: string
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: 6,
      include_answer: false,
    }),
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (data.results ?? [])
    .filter((r) => typeof r.title === 'string' && typeof r.url === 'string')
    .map((r) => ({
      title: String(r.title).trim(),
      url: String(r.url).trim(),
      snippet: typeof r.content === 'string' ? r.content.trim().slice(0, 220) : '',
    }));
}

async function searchBrave(
  query: string,
  apiKey: string
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=6`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (data.web?.results ?? [])
    .filter((r) => typeof r.title === 'string' && typeof r.url === 'string')
    .map((r) => ({
      title: String(r.title).trim(),
      url: String(r.url).trim(),
      snippet: typeof r.description === 'string' ? r.description.trim().slice(0, 220) : '',
    }));
}

async function searchYouTubeVideos(
  topic: string,
  languageLabel: string,
  apiKey: string
): Promise<EkuResourceItem[]> {
  const cfg = getLanguageConfig(languageLabel);
  const queryText =
    languageLabel.toLowerCase() === 'english'
      ? `${topic} tutorial lecture`
      : `${topic} ${languageLabel} tutorial`;

  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  searchUrl.searchParams.set('part', 'snippet');
  searchUrl.searchParams.set('type', 'video');
  searchUrl.searchParams.set('maxResults', '4');
  searchUrl.searchParams.set('q', queryText);
  searchUrl.searchParams.set('relevanceLanguage', cfg.isoCode);
  searchUrl.searchParams.set('safeSearch', 'strict');
  searchUrl.searchParams.set('key', apiKey);

  const searchRes = await fetch(searchUrl.toString(), {
    signal: AbortSignal.timeout(6500),
  });
  if (!searchRes.ok) return [];

  const searchJson = (await searchRes.json()) as {
    items?: Array<{
      id?: { videoId?: string };
      snippet?: {
        title?: string;
        description?: string;
        channelTitle?: string;
      };
    }>;
  };

  const items = (searchJson.items ?? []).filter((i) => typeof i.id?.videoId === 'string');
  if (items.length === 0) return [];

  const ids = items.map((i) => i.id!.videoId!).join(',');
  const detailsMap = new Map<
    string,
    { defaultAudioLanguage?: string; defaultLanguage?: string }
  >();

  try {
    const videosUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    videosUrl.searchParams.set('part', 'snippet');
    videosUrl.searchParams.set('id', ids);
    videosUrl.searchParams.set('key', apiKey);
    const videosRes = await fetch(videosUrl.toString(), {
      signal: AbortSignal.timeout(5000),
    });
    if (videosRes.ok) {
      const vJson = (await videosRes.json()) as {
        items?: Array<{
          id?: string;
          snippet?: { defaultAudioLanguage?: string; defaultLanguage?: string };
        }>;
      };
      for (const v of vJson.items ?? []) {
        if (v.id && v.snippet) {
          detailsMap.set(v.id, {
            defaultAudioLanguage: v.snippet.defaultAudioLanguage,
            defaultLanguage: v.snippet.defaultLanguage,
          });
        }
      }
    }
  } catch {
    // Metadata enrichment optional; fall back to title/description warning
  }

  const out: EkuResourceItem[] = [];
  for (const item of items) {
    const vid = item.id!.videoId!;
    const title = (item.snippet?.title || 'YouTube Study Video').trim();
    const desc = (item.snippet?.description || '').trim();
    const channel = (item.snippet?.channelTitle || 'YouTube').trim();
    const meta = detailsMap.get(vid);

    const audioTag = (meta?.defaultAudioLanguage || '').toLowerCase();
    const metaLangConfirmed = Boolean(audioTag && audioTag.startsWith(cfg.isoCode));

    if (
      languageLabel.toLowerCase() !== 'english' &&
      !metaLangConfirmed &&
      !matchesNonEnglishLanguageHint(`${title} ${desc} ${channel}`, languageLabel)
    ) {
      continue;
    }

    out.push({
      id: `yt-${vid}`,
      title,
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(vid)}`,
      sourceName: `YouTube · ${channel}`,
      language: languageLabel,
      resourceType: 'youtube_video',
      snippet: desc.slice(0, 180) || `${channel} video on ${topic}`,
      verifiedReachable: true,
      languageConfidence: metaLangConfirmed
        ? 'audio_metadata_confirmed'
        : 'title_or_metadata_only',
      disclaimer: metaLangConfirmed
        ? undefined
        : 'Language inferred from video title/metadata — check spoken audio track.',
    });
  }

  return out;
}

export interface ResourceSearchToolParams {
  topic: string;
  preferredLanguage?: string | null;
  includePdfs?: boolean;
  includeVideos?: boolean;
  allowFallbackPdfLanguage?: boolean;
}

export interface ResourceSearchToolResult {
  status:
    | 'ok'
    | 'needs_language_preference'
    | 'search_not_configured'
    | 'no_reliable_results';
  languageUsed?: string;
  resources: EkuResourceItem[];
  languageNotice?: EkuResourceLanguageNotice;
  message: string;
}

export function getSearchApiConfig() {
  const tavilyKey = (process.env.TAVILY_API_KEY || '').trim();
  const braveKey = (process.env.BRAVE_SEARCH_API_KEY || '').trim();
  const youtubeKey = (process.env.YOUTUBE_API_KEY || '').trim();
  return {
    tavilyKey: tavilyKey && tavilyKey !== 'MY_TAVILY_API_KEY' ? tavilyKey : '',
    braveKey: braveKey && braveKey !== 'MY_BRAVE_SEARCH_API_KEY' ? braveKey : '',
    youtubeKey: youtubeKey && youtubeKey !== 'MY_YOUTUBE_API_KEY' ? youtubeKey : '',
  };
}

export async function executeResourceSearch(
  params: ResourceSearchToolParams
): Promise<ResourceSearchToolResult> {
  const topic = params.topic.trim().slice(0, 140);
  if (!topic) {
    return {
      status: 'no_reliable_results',
      resources: [],
      message: 'Please provide a study topic to search for.',
    };
  }

  const language = normalizeLanguageName(params.preferredLanguage);
  if (!language) {
    return {
      status: 'needs_language_preference',
      resources: [],
      languageNotice: {
        requestedLanguage: '',
        needsLanguageSelection: true,
        topic,
        questionPrompt: `Which language do you prefer for "${topic}" resources (for example: English, Tamil, Hindi, etc.)?`,
      },
      message: `Ask the user which language they prefer for "${topic}" before searching.`,
    };
  }

  const { tavilyKey, braveKey, youtubeKey } = getSearchApiConfig();
  if (!tavilyKey && !braveKey && !youtubeKey) {
    return {
      status: 'search_not_configured',
      languageUsed: language,
      resources: [],
      message:
        'Web search APIs are not configured on this server (missing TAVILY_API_KEY, BRAVE_SEARCH_API_KEY, or YOUTUBE_API_KEY). Add at least one in Settings > Secrets so Eku can look up verified study links.',
    };
  }

  const includePdfs = params.includePdfs !== false;
  const includeVideos = params.includeVideos !== false;
  const isNonEnglish = language.toLowerCase() !== 'english';

  const runWebSearch = async (query: string) => {
    const raw: Array<{ title: string; url: string; snippet: string }> = [];
    if (tavilyKey) {
      raw.push(...(await searchTavily(query, tavilyKey)));
    } else if (braveKey) {
      raw.push(...(await searchBrave(query, braveKey)));
    }
    return raw;
  };

  const webQueries: string[] = [];
  if (tavilyKey || braveKey) {
    if (isNonEnglish) {
      webQueries.push(`${topic} ${language} tutorial notes`);
      if (includePdfs) {
        webQueries.push(`${topic} ${language} notes filetype:pdf`);
      }
    } else {
      webQueries.push(`${topic} official documentation lecture notes`);
      if (includePdfs) {
        webQueries.push(`${topic} university lecture notes filetype:pdf`);
      }
    }
  }

  const [videoResults, ...webQueryResults] = await Promise.all([
    includeVideos && youtubeKey ? searchYouTubeVideos(topic, language, youtubeKey) : Promise.resolve([]),
    ...webQueries.map((q) => runWebSearch(q)),
  ]);

  const rawWebCandidates = webQueryResults.flat();
  const seenUrls = new Set<string>();
  const verifiedWebResources: EkuResourceItem[] = [];

  for (const cand of rawWebCandidates) {
    const safe = isSafeExternalHttpsUrl(cand.url);
    if (!safe) continue;
    const normalizedUrl = safe.toString();
    if (seenUrls.has(normalizedUrl)) continue;
    seenUrls.add(normalizedUrl);

    if (scoreResourceTrust(normalizedUrl, 'educational_site') < 0) continue;

    // For non-English searches, reject generic English pages unless explicitly requesting fallback
    if (
      isNonEnglish &&
      !matchesNonEnglishLanguageHint(`${cand.title} ${cand.snippet} ${normalizedUrl}`, language)
    ) {
      continue;
    }

    const check = await verifyUrlReachable(normalizedUrl);
    if (!check.ok) continue;

    const rType = classifyWebResource(check.finalUrl, cand.title, cand.snippet, check.contentType);
    if (scoreResourceTrust(check.finalUrl, rType) < 0) continue;

    verifiedWebResources.push({
      id: `web-${verifiedWebResources.length + 1}`,
      title: cand.title.slice(0, 120),
      url: check.finalUrl,
      sourceName: new URL(check.finalUrl).hostname.replace(/^www\./, ''),
      language,
      resourceType: rType,
      snippet: cand.snippet || `Verified ${language} learning resource for ${topic}`,
      verifiedReachable: true,
      languageConfidence: 'title_or_metadata_only',
    });

    if (verifiedWebResources.length >= 4) break;
  }

  // Handle non-English video + PDF availability rule cleanly
  const matchingLangPdfs = verifiedWebResources.filter(
    (r) => r.resourceType === 'direct_pdf' || r.resourceType === 'pdf_host_page'
  );

  let fallbackEnglishPdfs: EkuResourceItem[] = [];
  let languageNotice: EkuResourceLanguageNotice | undefined;

  if (includePdfs && isNonEnglish && matchingLangPdfs.length === 0) {
    if (params.allowFallbackPdfLanguage && (tavilyKey || braveKey)) {
      const enRaw = await runWebSearch(`${topic} lecture notes filetype:pdf`);
      for (const cand of enRaw) {
        const safe = isSafeExternalHttpsUrl(cand.url);
        if (!safe || seenUrls.has(safe.toString())) continue;
        seenUrls.add(safe.toString());
        const check = await verifyUrlReachable(safe.toString());
        if (!check.ok) continue;
        const rType = classifyWebResource(check.finalUrl, cand.title, cand.snippet, check.contentType);
        if (rType === 'direct_pdf' || rType === 'pdf_host_page') {
          fallbackEnglishPdfs.push({
            id: `en-pdf-${fallbackEnglishPdfs.length + 1}`,
            title: cand.title.slice(0, 120),
            url: check.finalUrl,
            sourceName: new URL(check.finalUrl).hostname.replace(/^www\./, ''),
            language: 'English (fallback)',
            resourceType: rType,
            snippet: cand.snippet || `English PDF notes for ${topic}`,
            verifiedReachable: true,
            languageConfidence: 'title_or_metadata_only',
          });
          if (fallbackEnglishPdfs.length >= 2) break;
        }
      }
    } else {
      languageNotice = {
        requestedLanguage: language,
        missingPdfInRequestedLanguage: true,
        alternativePdfAvailable: Boolean(tavilyKey || braveKey),
        topic,
        questionPrompt:
          videoResults.length > 0
            ? `I found ${language} video resources for "${topic}", but no trustworthy ${language} PDF notes. Would you like me to include English PDF notes instead?`
            : `I couldn't find trustworthy ${language} PDFs for "${topic}". Would you like me to search for English PDF notes instead?`,
      };
    }
  }

  // Also grab YouTube links returned inside web search if no YouTube API key is configured
  const webYouTubeFallback = verifiedWebResources.filter((r) => r.resourceType === 'youtube_video');
  const nonVideoWeb = verifiedWebResources.filter((r) => r.resourceType !== 'youtube_video');

  nonVideoWeb.sort(
    (a, b) => scoreResourceTrust(b.url, b.resourceType) - scoreResourceTrust(a.url, a.resourceType)
  );

  const curated: EkuResourceItem[] = [];
  const allVideos = [...videoResults, ...webYouTubeFallback];
  if (allVideos.length > 0) curated.push(allVideos[0]);
  for (const w of nonVideoWeb) {
    if (curated.length >= 3) break;
    curated.push(w);
  }
  for (const fb of fallbackEnglishPdfs) {
    if (curated.length >= 3) break;
    curated.push(fb);
  }
  for (const v of allVideos.slice(1)) {
    if (curated.length >= 3) break;
    curated.push(v);
  }

  if (curated.length === 0) {
    return {
      status: 'no_reliable_results',
      languageUsed: language,
      resources: [],
      languageNotice,
      message: languageNotice?.questionPrompt
        ? languageNotice.questionPrompt
        : `I could not find verified, trustworthy ${language} study resources for "${topic}".`,
    };
  }

  return {
    status: 'ok',
    languageUsed: language,
    resources: curated.slice(0, 3),
    languageNotice,
    message: `Found ${curated.slice(0, 3).length} verified ${language} resources for "${topic}".`,
  };
}
