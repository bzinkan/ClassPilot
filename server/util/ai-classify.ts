/**
 * AI Content Classification Module
 *
 * Two-layer classification:
 * 1. OpenAI Moderation API (free) — flags dangerous content (self-harm, violence, sexual)
 * 2. Gemini Flash (cheap/fast) — classifies educational vs non-educational
 *
 * Results cached by domain with 24h TTL.
 */

export interface ClassificationResult {
  category: 'educational' | 'non-educational' | 'unknown';
  safetyAlert: 'self-harm' | 'violence' | 'sexual' | null;
  domain: string;
  classifiedAt: number;
}

interface CacheEntry {
  result: ClassificationResult;
  expireAt: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const classificationCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ClassificationResult>>();

// Clean expired cache entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of Array.from(classificationCache.entries())) {
    if (now > entry.expireAt) {
      classificationCache.delete(key);
    }
  }
}, 60 * 60 * 1000);

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Skip classification for known-safe internal/browser pages
const SKIP_DOMAINS = new Set([
  'chrome-extension',
  'chrome',
  'newtab',
  'extensions',
  'localhost',
]);

function shouldSkip(domain: string): boolean {
  if (SKIP_DOMAINS.has(domain)) return true;
  if (domain === '' || domain === 'newtab') return true;
  return false;
}

/**
 * Main entry point — classify a URL.
 * Returns cached result if available, otherwise calls APIs.
 * Returns null if URL is invalid or APIs are not configured.
 */
export async function classifyUrl(url: string): Promise<ClassificationResult | null> {
  if (!process.env.OPENAI_API_KEY) return null;

  const domain = extractDomain(url);
  if (!domain || shouldSkip(domain)) return null;

  // Check cache
  const cached = classificationCache.get(domain);
  if (cached && Date.now() < cached.expireAt) {
    return cached.result;
  }

  // Dedup in-flight requests for same domain
  const existing = inflight.get(domain);
  if (existing) return existing;

  const promise = classifyDomain(domain);
  inflight.set(domain, promise);

  try {
    const result = await promise;
    classificationCache.set(domain, { result, expireAt: Date.now() + CACHE_TTL_MS });
    return result;
  } finally {
    inflight.delete(domain);
  }
}

async function classifyDomain(domain: string): Promise<ClassificationResult> {
  const [safetyAlert, category] = await Promise.all([
    checkOpenAISafety(domain).catch((err) => {
      console.error('[AI] OpenAI Moderation error:', err.message);
      return null;
    }),
    classifyEducational(domain).catch((err) => {
      console.error('[AI] Gemini classification error:', err.message);
      return 'unknown' as const;
    }),
  ]);

  return {
    category,
    safetyAlert,
    domain,
    classifiedAt: Date.now(),
  };
}

/**
 * OpenAI Moderation API — free, fast.
 * Returns the safety category if flagged, null if safe.
 */
async function checkOpenAISafety(domain: string): Promise<'self-harm' | 'violence' | 'sexual' | null> {
  const response = await fetch('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ input: domain }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI Moderation API returned ${response.status}`);
  }

  const data = await response.json() as {
    results: Array<{
      flagged: boolean;
      categories: Record<string, boolean>;
    }>;
  };

  const result = data.results?.[0];
  if (!result?.flagged) return null;

  const cats = result.categories;
  if (cats['self-harm'] || cats['self-harm/intent'] || cats['self-harm/instructions']) return 'self-harm';
  if (cats['violence'] || cats['violence/graphic']) return 'violence';
  if (cats['sexual'] || cats['sexual/minors']) return 'sexual';

  return null;
}

/**
 * Gemini Flash — cheap, fast.
 * Classifies domain as educational or non-educational.
 */
async function classifyEducational(domain: string): Promise<'educational' | 'non-educational' | 'unknown'> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return 'unknown';

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Classify this website domain for a K-12 school setting. Is "${domain}" an educational/productivity website or a non-educational website (gaming, social media, entertainment, shopping, etc.)?

Reply with ONLY one word: "educational" or "non-educational"`,
          }],
        }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 10,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini API returned ${response.status}`);
  }

  const data = await response.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.toLowerCase().trim() ?? '';

  if (text.includes('non-educational')) return 'non-educational';
  if (text.includes('educational')) return 'educational';
  return 'unknown';
}
