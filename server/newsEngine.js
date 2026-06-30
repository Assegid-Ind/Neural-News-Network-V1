import { XMLParser } from "fast-xml-parser";
import { sources } from "./data/sources.js";
import { fallbackArticles } from "./data/fallback.js";
import { generatePerspectiveArticle, openAiStatus } from "./openaiClient.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text"
});

const articleFetchLimit = 36;
const articleConcurrency = 6;

const stopWords = new Set([
  "about",
  "after",
  "again",
  "also",
  "amid",
  "been",
  "being",
  "author",
  "between",
  "comments",
  "could",
  "daily",
  "digest",
  "email",
  "feed",
  "from",
  "have",
  "homepage",
  "into",
  "more",
  "news",
  "over",
  "posts",
  "posted",
  "privacy",
  "said",
  "says",
  "share",
  "subscribe",
  "than",
  "that",
  "they",
  "their",
  "them",
  "there",
  "this",
  "with",
  "will",
  "would",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "wired",
  "verge",
  "your"
]);

const weakLeadWords = new Set(["watch", "live", "updates", "latest", "briefing"]);

export async function buildIssue(agents, options = {}) {
  const articles = await collectArticles();
  const clusters = clusterArticles(articles).slice(0, 12);
  const storyDrafts = clusters.map((cluster, index) => {
    const factPack = createFactPack(cluster);
    return {
      id: `story-${index}-${hash(factPack.headline)}`,
      rank: index + 1,
      topic: factPack.topic,
      headline: factPack.headline,
      deck: factPack.summary,
      heat: Math.min(99, 38 + cluster.length * 10 + factPack.confirmed.length * 4 + factPack.sourceDossiers.length * 3),
      factPack,
      synthesis: writeSynthesis(factPack),
      perspectives: [],
      sources: cluster.map(({ headline, source, link, publishedAt }) => ({
        headline,
        source,
        link,
        publishedAt
      }))
    };
  });
  const stories = await attachPerspectives(storyDrafts, agents);

  return {
    publication: "Neural News Network",
    generatedAt: new Date().toISOString(),
    refreshEveryMs: options.refreshEveryMs || 1000 * 60 * 8,
    generationMode: openAiStatus().available ? "openai" : "local-fallback",
    ai: openAiStatus(),
    sourceCount: articles.length,
    enrichedSourceCount: articles.filter((article) => article.enriched).length,
    storyCount: stories.length,
    lead: stories[0] || null,
    stories
  };
}

async function attachPerspectives(stories, agents) {
  const jobs = stories.flatMap((story, storyIndex) =>
    agents.map((agent, agentIndex) => async () => ({
      storyIndex,
      agentIndex,
      perspective: await writePerspective(agent, story.factPack)
    }))
  );
  const results = await runJobPool(jobs, Number(process.env.OPENAI_AGENT_CONCURRENCY || 2));
  const grouped = new Map(results.map((result) => [`${result.storyIndex}:${result.agentIndex}`, result.perspective]));
  return stories.map((story, storyIndex) => ({
    ...story,
    perspectives: agents.map((_, agentIndex) => grouped.get(`${storyIndex}:${agentIndex}`)).filter(Boolean)
  }));
}

async function runJobPool(jobs, concurrency) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), jobs.length) }, async () => {
    while (index < jobs.length) {
      const current = jobs[index];
      index += 1;
      results.push(await current());
    }
  });
  await Promise.all(workers);
  return results;
}

async function collectArticles() {
  const results = await Promise.allSettled(sources.map(readFeed));
  const live = results
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .filter((article) => article.headline && article.summary);

  const deduped = dedupeByHeadline(live).slice(0, 80);
  const enriched = await enrichArticles(deduped);
  if (enriched.length >= 10) return enriched;
  return dedupeByHeadline([...enriched, ...fallbackArticles.map(normalizeFallbackArticle)]);
}

async function readFeed(source) {
  const response = await fetch(source.url, {
    headers: {
      "user-agent": "NeuralNewsNetwork/1.0 (+local newspaper research prototype)"
    },
    signal: AbortSignal.timeout(9000)
  });
  if (!response.ok) throw new Error(`Feed failed: ${source.name}`);
  const xml = await response.text();
  const parsed = parser.parse(xml);
  const items =
    parsed?.rss?.channel?.item ||
    parsed?.feed?.entry ||
    parsed?.RDF?.item ||
    [];
  return asArray(items)
    .slice(0, 15)
    .map((item, index) => normalizeItem(item, source, index))
    .filter(Boolean);
}

function normalizeItem(item, source, index) {
  const headline = cleanText(readText(item.title));
  const link = readLink(item.link);
  const publishedAt =
    readText(item.pubDate) ||
    readText(item.published) ||
    readText(item.updated) ||
    new Date().toISOString();
  const summary =
    cleanText(readText(item.description)) ||
    cleanText(readText(item.summary)) ||
    cleanText(readText(item["content:encoded"])) ||
    headline;
  const content =
    cleanText(readText(item["content:encoded"])) ||
    cleanText(readText(item.content)) ||
    summary;

  if (!headline) return null;
  const text = `${headline}. ${summary}. ${content}`.slice(0, 1600);
  return {
    id: `${source.name}-${index}-${hash(headline)}`,
    headline,
    source: source.name,
    link,
    publishedAt: safeDate(publishedAt),
    topic: source.topic,
    summary: summary.slice(0, 720),
    text,
    extractedText: text,
    paragraphs: splitSentences(text).slice(0, 6),
    headlineKeywords: keywords(headline, 12),
    keywords: keywords(`${headline} ${headline} ${summary} ${content}`),
    enriched: false,
    extractionStatus: "feed"
  };
}

function normalizeFallbackArticle(article) {
  const text = `${article.headline}. ${article.summary}. ${article.text}`;
  return {
    ...article,
    extractedText: text,
    paragraphs: splitSentences(text).slice(0, 8),
    headlineKeywords: keywords(article.headline, 12),
    keywords: keywords(`${article.headline} ${article.headline} ${article.summary} ${article.text}`),
    enriched: true,
    extractionStatus: "fallback"
  };
}

async function enrichArticles(articles) {
  const toEnrich = articles
    .filter((article) => article.link && /^https?:\/\//i.test(article.link))
    .slice(0, articleFetchLimit);
  const enrichedMap = new Map();

  await runPool(toEnrich, articleConcurrency, async (article) => {
    const enriched = await enrichArticle(article);
    enrichedMap.set(article.id, enriched);
  });

  return articles.map((article) => enrichedMap.get(article.id) || article);
}

async function enrichArticle(article) {
  try {
    const page = await fetchArticlePage(article.link);
    if (!page.text || page.text.length < article.text.length * 0.9) {
      return {
        ...article,
        extractionStatus: page.status || "feed-only"
      };
    }
    const summary = page.description || article.summary;
    const text = `${page.title || article.headline}. ${summary}. ${page.text}`.slice(0, 9000);
    return {
      ...article,
      headline: page.title && titleLooksBetter(page.title, article.headline) ? page.title : article.headline,
      canonicalUrl: page.canonicalUrl || article.link,
      author: page.author,
      image: page.image,
      publishedAt: safeDate(page.publishedAt || article.publishedAt),
      summary: summary.slice(0, 900),
      text,
      extractedText: page.text,
      paragraphs: page.paragraphs.slice(0, 16),
      headlineKeywords: keywords(article.headline, 12),
      keywords: keywords(`${article.headline} ${article.headline} ${summary} ${page.text}`),
      enriched: true,
      extractionStatus: "article-page"
    };
  } catch {
    return {
      ...article,
      extractionStatus: "feed-only"
    };
  }
}

async function fetchArticlePage(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "text/html,application/xhtml+xml",
      "user-agent":
        "Mozilla/5.0 (compatible; NeuralNewsNetwork/1.0; local research prototype)"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(8500)
  });
  if (!response.ok) return { status: `http-${response.status}` };
  const html = await response.text();
  return extractReadablePage(html, response.url);
}

function extractReadablePage(html, finalUrl) {
  const metadata = extractMetadata(html);
  const jsonLd = extractJsonLd(html);
  const paragraphs = extractParagraphs(html);
  const text = paragraphs.join(" ");
  return {
    title: metadata.title || jsonLd.headline,
    description: metadata.description || jsonLd.description,
    canonicalUrl: metadata.canonicalUrl || finalUrl,
    author: metadata.author || jsonLd.author,
    image: metadata.image || jsonLd.image,
    publishedAt: metadata.publishedAt || jsonLd.publishedAt,
    paragraphs,
    text,
    status: text ? "article-page" : "empty-page"
  };
}

function extractMetadata(html) {
  const title =
    meta(html, "og:title") ||
    meta(html, "twitter:title") ||
    tagText(html, "title");
  return {
    title: cleanText(title),
    description: cleanText(
      meta(html, "description") ||
        meta(html, "og:description") ||
        meta(html, "twitter:description")
    ),
    author: cleanText(meta(html, "author") || meta(html, "article:author")),
    image: meta(html, "og:image") || meta(html, "twitter:image"),
    publishedAt:
      meta(html, "article:published_time") ||
      meta(html, "date") ||
      meta(html, "pubdate") ||
      meta(html, "parsely-pub-date"),
    canonicalUrl: linkRel(html, "canonical")
  };
}

function extractJsonLd(html) {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => decodeHtml(match[1]).trim())
    .slice(0, 8);
  for (const script of scripts) {
    try {
      const parsed = JSON.parse(script);
      const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(parsed["@graph"] || [])];
      const article = nodes.find((node) => {
        const type = Array.isArray(node?.["@type"]) ? node["@type"].join(" ") : node?.["@type"];
        return /Article|NewsArticle|ReportageNewsArticle/i.test(type || "");
      });
      if (!article) continue;
      return {
        headline: cleanText(article.headline || article.name),
        description: cleanText(article.description),
        author: cleanText(asArray(article.author).map((author) => author?.name || author).filter(Boolean).join(", ")),
        image: Array.isArray(article.image) ? article.image[0]?.url || article.image[0] : article.image?.url || article.image,
        publishedAt: article.datePublished || article.dateCreated
      };
    } catch {
      // Ignore invalid publisher JSON-LD and continue with meta tags.
    }
  }
  return {};
}

function extractParagraphs(html) {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const paragraphs = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => cleanText(match[1]))
    .filter((paragraph) => paragraph.length >= 55)
    .filter((paragraph) => !/subscribe|sign up|newsletter|advertisement|cookies|all rights reserved|email digest|homepage|comments policy|privacy policy/i.test(paragraph))
    .filter((paragraph) => paragraph.split(/\s+/).length >= 9);
  return [...new Set(paragraphs)].slice(0, 28);
}

async function runPool(items, concurrency, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await worker(current);
    }
  });
  await Promise.all(workers);
}

function readText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.text || value["#text"] || value.href || "";
}

function readLink(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return readLink(value[0]);
  return value.href || value.text || "";
}

function asArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function meta(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const byProperty = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
  const contentFirst = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i");
  return decodeHtml(html.match(byProperty)?.[1] || html.match(contentFirst)?.[1] || "");
}

function linkRel(html, rel) {
  const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hrefLast = new RegExp(`<link[^>]+rel=["'][^"']*${escaped}[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>`, "i");
  const hrefFirst = new RegExp(`<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*${escaped}[^"']*["'][^>]*>`, "i");
  return decodeHtml(html.match(hrefLast)?.[1] || html.match(hrefFirst)?.[1] || "");
}

function tagText(html, tag) {
  const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return decodeHtml(match?.[1] || "");
}

function cleanText(text) {
  return decodeHtml(String(text || ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function safeDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function titleLooksBetter(candidate, current) {
  if (!candidate || candidate.length < 12) return false;
  if (candidate.length > 160) return false;
  const candidateWords = keywords(candidate);
  const currentWords = new Set(keywords(current));
  if (candidateWords.some((word) => weakLeadWords.has(word))) return false;
  return candidateWords.filter((word) => currentWords.has(word)).length >= 2;
}

function dedupeByHeadline(articles) {
  const seen = new Set();
  return articles.filter((article) => {
    const key = article.headline.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 70);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clusterArticles(articles) {
  const clusters = [];
  const sorted = [...articles].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  for (const article of sorted) {
    let bestCluster = null;
    let bestScore = 0;
    for (const cluster of clusters) {
      const score = similarity(article.keywords, cluster.keywords);
      const headlineScore = similarity(article.headlineKeywords, cluster.headlineKeywords);
      const sourceDiversity = new Set(cluster.articles.map((item) => item.source).concat(article.source)).size;
      const adjustedScore = headlineScore >= 0.18 || sourceDiversity > 1 ? score : score * 0.55;
      if (adjustedScore > bestScore) {
        bestScore = adjustedScore;
        bestCluster = cluster;
      }
    }
    if (bestCluster && bestScore >= 0.24) {
      bestCluster.articles.push(article);
      bestCluster.keywords = keywords(bestCluster.articles.map((item) => item.text).join(" "));
      bestCluster.headlineKeywords = keywords(bestCluster.articles.map((item) => item.headline).join(" "), 18);
    } else {
      clusters.push({ articles: [article], keywords: article.keywords, headlineKeywords: article.headlineKeywords });
    }
  }

  return clusters
    .sort((a, b) => clusterRank(b.articles) - clusterRank(a.articles))
    .map((cluster) => cluster.articles);
}

function newest(cluster) {
  return Math.max(...cluster.map((article) => new Date(article.publishedAt).getTime()));
}

function clusterRank(cluster) {
  const text = cluster.map((article) => `${article.headline} ${article.summary} ${article.keywords.join(" ")}`).join(" ").toLowerCase();
  const ageHours = Math.max(1, (Date.now() - newest(cluster)) / 36e5);
  const sourceDiversity = new Set(cluster.map((article) => article.source)).size;
  const enriched = cluster.filter((article) => article.enriched).length;
  const commercePenalty = countNeedles(text, ["deal", "deals", "prime day", "sale", "off", "coupon", "discount", "best price"]) * 14;
  const newsBoost = countNeedles(text, ["court", "law", "government", "president", "minister", "war", "ceasefire", "fire", "killed", "rescue", "climate", "heatwave", "scientists", "researchers", "economy", "market", "policy"]) * 5;
  return cluster.length * 18 + sourceDiversity * 12 + enriched * 4 + newsBoost - commercePenalty - Math.min(18, ageHours / 3);
}

function countNeedles(text, needles) {
  return needles.reduce((sum, needle) => sum + (text.includes(needle) ? 1 : 0), 0);
}

function keywords(text, limit = 22) {
  const words = String(text)
    .toLowerCase()
    .match(/[a-z][a-z-]{3,}/g);
  if (!words) return [];
  const counts = new Map();
  for (const word of words) {
    const normalized = word.replace(/'s$/, "").replace(/-+/g, "-");
    if (stopWords.has(normalized)) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function similarity(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  const overlap = [...left].filter((word) => right.has(word)).length;
  return overlap / Math.max(1, Math.min(left.size, right.size));
}

function createFactPack(cluster) {
  const combined = cluster.map((article) => article.text).join(" ");
  const lead = chooseLeadArticle(cluster);
  const allSentences = splitSentences(combined);
  const entities = extractEntities(combined);
  const numbers = extractNumbers(combined);
  const dates = extractDates(combined, cluster);
  const sourceDossiers = cluster.map(createSourceDossier);
  const confirmed = extractConfirmed(cluster, allSentences);
  const claims = sourceDossiers.flatMap((source) => source.claims.map((claim) => ({ ...claim, source: source.source })));
  const disputed = extractDisputed(allSentences, claims);
  const openQuestions = extractOpenQuestions(cluster, disputed, numbers);
  const context = extractContext(allSentences);
  const stakes = extractStakes(lead.topic, entities, numbers, disputed);

  return {
    headline: rewriteHeadline(lead.headline, cluster),
    summary: summarizeCluster(cluster, lead),
    topic: lead.topic,
    whatHappened: confirmed[0] || lead.summary,
    who: entities.peopleOrOrgs.slice(0, 10),
    where: entities.places.slice(0, 6),
    when: dates,
    confirmed,
    disputed,
    unclear: openQuestions,
    importantNumbers: numbers,
    keywords: keywords(combined, 14),
    context,
    stakes,
    timeline: buildTimeline(cluster, dates),
    sourceDossiers,
    claims,
    evidence: extractEvidence(sourceDossiers, confirmed),
    sourceLinks: cluster.map((article) => article.link).filter(Boolean),
    extraction: {
      totalSources: cluster.length,
      enrichedSources: cluster.filter((article) => article.enriched).length,
      statuses: countBy(cluster.map((article) => article.extractionStatus))
    },
    detailText: sourceDossiers.map((source) => `${source.source}: ${source.excerpt}`).join(" ")
  };
}

function chooseLeadArticle(cluster) {
  return [...cluster].sort((a, b) => {
    const scoreA = (a.enriched ? 2 : 0) + a.extractedText.length / 2500;
    const scoreB = (b.enriched ? 2 : 0) + b.extractedText.length / 2500;
    return scoreB - scoreA;
  })[0] || cluster[0];
}

function createSourceDossier(article) {
  const sentences = splitSentences(article.extractedText || article.text);
  return {
    source: article.source,
    headline: article.headline,
    link: article.canonicalUrl || article.link,
    publishedAt: article.publishedAt,
    author: article.author,
    summary: article.summary,
    excerpt: selectInformativeSentences(sentences, 5).join(" "),
    claims: selectInformativeSentences(sentences, 5).map((sentence) => ({
      text: sentence,
      numbers: extractNumbers(sentence),
      entities: extractEntities(sentence).peopleOrOrgs.slice(0, 4)
    })),
    numbers: extractNumbers(article.extractedText || article.text),
    keywords: article.keywords.slice(0, 10),
    extractionStatus: article.extractionStatus
  };
}

function rewriteHeadline(headline, cluster) {
  if (cluster.length === 1) return headline;
  const sourcePhrase = `${cluster.length} sources`;
  return `${headline.replace(/\.$/, "")}`;
}

function summarizeCluster(cluster, lead) {
  const bestSentences = selectInformativeSentences(
    cluster.flatMap((article) => splitSentences(article.summary || article.extractedText || article.text)),
    3
  );
  const sourcePhrase =
    cluster.length > 1
      ? `${cluster.length} sources provide overlapping accounts`
      : `${lead.source} provides the main account`;
  return `${bestSentences.join(" ")} ${sourcePhrase}, with analysis grounded in the linked reporting.`;
}

function splitSentences(text) {
  return cleanText(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 30)
    .filter((sentence) => sentence.split(/\s+/).length >= 7);
}

function selectInformativeSentences(sentences, limit) {
  const seen = new Set();
  return sentences
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((sentence) => {
      const key = sentence.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 90);
      if (seen.has(key)) return false;
      seen.add(key);
      return !/click here|subscribe|newsletter|advertisement/i.test(sentence);
    })
    .sort((a, b) => sentenceScore(b) - sentenceScore(a))
    .slice(0, limit);
}

function sentenceScore(sentence) {
  let score = 0;
  if (/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/.test(sentence)) score += 2;
  if (/\d/.test(sentence)) score += 2;
  if (/\bsaid|reported|announced|according|warned|accused|confirmed|filed|voted|approved\b/i.test(sentence)) score += 2;
  score += Math.min(3, sentence.split(/\s+/).length / 18);
  return score;
}

function extractEntities(text) {
  const matches = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g) || [];
  const counts = new Map();
  for (const match of matches) {
    if (["The", "This", "That", "Several", "Officials", "Researchers", "Advertisement"].includes(match)) continue;
    counts.set(match, (counts.get(match) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  return {
    peopleOrOrgs: ranked.filter((name) => !placeWords.some((place) => name.includes(place))),
    places: ranked.filter((name) => placeWords.some((place) => name.includes(place)))
  };
}

function extractDates(text, cluster) {
  const relative = text.match(/\b(today|yesterday|this week|this month|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi) || [];
  const monthDates = text.match(/\b(?:Jan\.?|January|Feb\.?|February|Mar\.?|March|Apr\.?|April|May|Jun\.?|June|Jul\.?|July|Aug\.?|August|Sep\.?|September|Oct\.?|October|Nov\.?|November|Dec\.?|December)\s+\d{1,2}(?:,\s+\d{4})?\b/g) || [];
  const published = [...new Set(cluster.map((article) => article.publishedAt.slice(0, 10)))];
  return [...new Set([...monthDates, ...relative, ...published])].slice(0, 10);
}

function extractNumbers(text) {
  const matches = text.match(/\b\d+(?:,\d{3})*(?:\.\d+)?%?|\$\d+(?:,\d{3})*(?:\.\d+)?\s?(?:million|billion|trillion)?/gi) || [];
  return [...new Set(matches)].slice(0, 14);
}

function extractConfirmed(cluster, sentences) {
  const sourceCount = new Map();
  for (const article of cluster) {
    for (const word of new Set(article.keywords.slice(0, 12))) {
      sourceCount.set(word, (sourceCount.get(word) || 0) + 1);
    }
  }
  const sharedWords = [...sourceCount.entries()]
    .filter(([, count]) => count > 1 || cluster.length === 1)
    .map(([word]) => word);
  const ranked = sentences
    .filter((sentence) => sharedWords.some((word) => sentence.toLowerCase().includes(word)))
    .sort((a, b) => sentenceScore(b) - sentenceScore(a));
  return selectInformativeSentences(ranked.length ? ranked : sentences, 7);
}

function extractDisputed(sentences, claims) {
  const cues = ["dispute", "debate", "unclear", "claimed", "alleged", "questions", "scrutiny", "denied", "accused", "warned"];
  const cueSentences = sentences.filter((sentence) => cues.some((cue) => sentence.toLowerCase().includes(cue)));
  const claimTexts = claims.map((claim) => claim.text);
  return selectInformativeSentences([...cueSentences, ...claimTexts], 5);
}

function extractOpenQuestions(cluster, disputed, numbers) {
  const questions = [];
  if (cluster.filter((article) => article.enriched).length < Math.min(2, cluster.length)) {
    questions.push("Full article extraction was limited for part of the source set, so some reporting detail may remain outside the local dossier.");
  }
  if (cluster.length < 3) {
    questions.push("The cluster has limited independent sourcing; stronger corroboration would require more outlets or primary documents.");
  }
  if (!numbers.length) {
    questions.push("The source set gives few hard numbers, which limits cost, scale, and impact analysis.");
  }
  if (disputed.length) {
    questions.push("At least one important claim is framed as contested, unresolved, or dependent on further verification.");
  }
  questions.push("The next material fact to watch is who takes responsibility for the follow-through and what evidence they release.");
  return questions.slice(0, 5);
}

function extractContext(sentences) {
  const contextCues = ["since", "after", "before", "following", "years", "months", "previously", "long-running", "history"];
  const context = sentences.filter((sentence) => contextCues.some((cue) => sentence.toLowerCase().includes(cue)));
  return selectInformativeSentences(context, 5);
}

function extractStakes(topic, entities, numbers, disputed) {
  const actor = entities.peopleOrOrgs[0] || "the central actors";
  const numberPhrase = numbers.length ? ` The available numbers include ${numbers.slice(0, 4).join(", ")}.` : "";
  const disputePhrase = disputed.length ? " The dispute matters because contested facts can change who is responsible and what remedy is credible." : "";
  const topicFrame = {
    World: "The stakes are geopolitical credibility, civilian security, and the risk that local events spill across borders.",
    National: "The stakes are public trust, administrative competence, and whether national institutions can answer a fast-moving event.",
    Technology: "The stakes are control over infrastructure, market power, public safety, and the pace at which technical change outruns governance.",
    Economy: "The stakes are cost allocation, confidence, investment signals, and whether risks are shifted onto people with the least leverage.",
    Science: "The stakes are evidence quality, public understanding, and the translation of technical findings into policy or behavior.",
    Law: "The stakes are authority, rights, precedent, and whether the response fits the facts."
  };
  return `${topicFrame[topic] || "The stakes are accountability, consequences, and public trust"} ${actor} sits near the center of the available reporting.${numberPhrase}${disputePhrase}`;
}

function buildTimeline(cluster, dates) {
  const published = cluster.map((article) => ({
    date: article.publishedAt,
    source: article.source,
    event: article.headline
  }));
  return [
    ...dates.slice(0, 4).map((date) => ({ date, event: "Date referenced in source material" })),
    ...published
  ].slice(0, 8);
}

function extractEvidence(sourceDossiers, confirmed) {
  const sourceList = sourceDossiers.map((source) => source.source).join(", ");
  return [
    `${sourceDossiers.length} source dossier${sourceDossiers.length === 1 ? "" : "s"} contributed to this cluster: ${sourceList}.`,
    ...confirmed.slice(0, 4)
  ];
}

function countBy(values) {
  return values.reduce((acc, value) => {
    acc[value || "unknown"] = (acc[value || "unknown"] || 0) + 1;
    return acc;
  }, {});
}

function writeSynthesis(factPack) {
  return [
    `The strongest shared reading is that ${factPack.whatHappened.replace(/\.$/, "")}.`,
    factPack.stakes,
    `The article set is useful because it gives both direct claims and gaps: ${factPack.confirmed.slice(0, 2).join(" ")} The unresolved side is just as important: ${factPack.unclear[0]}`,
    `That means the story should be read less as a single event than as a test of follow-through. The next credible account will need firmer evidence, clearer responsibility, and enough detail for readers to judge whether the public explanation matches the scale of the consequences.`
  ].join("\n\n");
}

async function writePerspective(agent, factPack) {
  try {
    const generated = await generatePerspectiveArticle(agent, factPack);
    if (generated) {
      return {
        agentId: agent.id,
        alias: agent.alias,
        kind: agent.kind,
        publicLine: agent.publicLine,
        promptUsed: agent.editorialPrompt,
        generation: "openai",
        headline: `${agent.alias}: ${generated.headline}`,
        dek: generated.dek,
        body: generated.body,
        uncertaintyNote: generated.uncertaintyNote
      };
    }
  } catch (error) {
    console.warn(`OpenAI generation failed for ${agent.alias}: ${error.message}`);
  }

  const core = {
    "Institutional Realist": institutionalTake,
    "Legal-Philosophical Analyst": legalTake,
    "Markets Analyst": marketTake,
    "Populist Firebrand": populistTake
  };
  const writer = core[agent.perspective] || historicalTake;
  return {
    agentId: agent.id,
    alias: agent.alias,
    kind: agent.kind,
    publicLine: agent.publicLine,
    promptUsed: agent.editorialPrompt,
    generation: "local-fallback",
    headline: `${agent.alias}: ${titleFor(agent, factPack)}`,
    body: writer(agent, factPack)
  };
}

function titleFor(agent, factPack) {
  const subject = titleSubject(factPack);
  if (agent.kind === "historical") return `The Old Question Beneath the ${subject}`;
  if (agent.perspective.includes("Markets")) return `The Hidden Bill Behind the ${subject}`;
  if (agent.perspective.includes("Legal")) return `Before Judgment, the Facts Must Hold`;
  if (agent.perspective.includes("Populist")) return `Trust Is Not a Press Release`;
  return `The Hard Part Comes After the ${subject}`;
}

function titleSubject(factPack) {
  const text = `${factPack.headline} ${factPack.keywords.join(" ")}`.toLowerCase();
  const patterns = [
    [/rescue|rubble|survivor|trapped/, "Rescue"],
    [/heatwave|heat|temperature|climate/, "Heatwave"],
    [/wildfire|firefighter|fire\b/, "Fire"],
    [/ceasefire|strike|iran|israel|hezbollah/, "Ceasefire"],
    [/court|judge|ruling|law|legal/, "Ruling"],
    [/virus|cell|brain|scientist|research|discovery/, "Discovery"],
    [/streaming|subscription|ad-free/, "Streaming Shift"],
    [/deal|prime|sale|discount/, "Deal"],
    [/cyber|ai|supercomputer|technology/, "Technology Race"]
  ];
  const match = patterns.find(([pattern]) => pattern.test(text));
  if (match) return match[1];
  const keyword = factPack.keywords.find((word) => !["people", "government", "still", "just"].includes(word));
  return keyword ? toTitleCase(keyword) : "Headline";
}

function toTitleCase(value) {
  return String(value || "")
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function institutionalTake(agent, factPack) {
  return article([
    `A story can look finished when the dramatic moment arrives. The rescue is made, the order is issued, the warning is sounded, the casualty number is released. But the public test usually begins after the headline, when someone has to account for how the event happened and what will be done next. Here, the source set gives us the central fact: ${factPack.whatHappened}`,
    `${detailSentence(factPack)} Those details matter because authority is not an atmosphere; it is a chain of decisions. Readers should be able to see who had responsibility, who had information, who had the power to act, and who will answer if the explanation changes tomorrow.`,
    `The strongest reporting points in one direction: ${factPack.confirmed.slice(0, 3).join(" ")} Yet the gaps are just as revealing. ${factPack.unclear.slice(0, 2).join(" ")} A capable system does not pretend those gaps are harmless. It narrows them in public.`,
    `That is why the next chapter matters more than the first statement. Competence will look like documents, timelines, named responsibility, and decisions that can be checked against evidence. Drift will look like solemn language and no owner. The difference between the two is the difference between a public that is governed and a public that is merely asked to believe.`
  ]);
}

function legalTake(agent, factPack) {
  return article([
    `Before a society can judge wisely, it has to know what it is judging. That sounds modest, almost procedural, but it is the line between public reason and public appetite. The reporting establishes this much: ${factPack.whatHappened}`,
    `The rest demands care. ${factPack.unclear.slice(0, 2).join(" ")} ${factPack.disputed.length ? `The disputed material sharpens the point: ${factPack.disputed.slice(0, 2).join(" ")}` : "Even where no explicit legal fight appears in the reporting, the limits of the evidence should discipline the conclusion."}`,
    `${factPack.stakes} Rights and duties cannot be responsibly assigned in a fog. A response can be urgent without being careless; it can be forceful without becoming arbitrary. The measure is whether power explains itself well enough for citizens to see the rule beneath the result.`,
    `That is the question to keep open: who may act, on what evidence, under what limit, and with what remedy if the story changes? A headline can satisfy curiosity. It cannot substitute for proof.`
  ]);
}

function marketTake(agent, factPack) {
  const numberLine = factPack.importantNumbers.length
    ? `The available numbers are not decoration; they are the first map of scale: ${factPack.importantNumbers.slice(0, 7).join(", ")}.`
    : "The absence of strong numbers is itself a market signal, because uncertainty gets priced before certainty arrives.";
  return article([
    `Every public event eventually produces a bill. Sometimes it is measured in money; sometimes in time, credibility, insurance, political capital, or risk pushed onto people who did not choose it. The reporting begins here: ${factPack.whatHappened}`,
    numberLine,
    `${detailSentence(factPack)} The useful question is not only what happened, but how the consequences are allocated. Who can pass costs along? Who can delay? Who can leave? Who is trapped inside the outcome? These are the practical questions beneath the public language.`,
    `The source set does not yet answer every pricing question. ${factPack.unclear.slice(0, 2).join(" ")} That is where the next reporting should go. Follow the contracts, the capacity constraints, the subsidies, the liability, and the people who cannot opt out. The money trail will not replace the moral argument; it will show where the moral argument has to land.`
  ]);
}

function populistTake(agent, factPack) {
  return article([
    `People know when an official story has holes. They may not have the documents, the title, or the microphone, but they can hear the difference between an explanation and a performance. The plain version of this story is: ${factPack.whatHappened}`,
    `${factPack.stakes} That is why the public is entitled to ask the impolite questions. Who knew? Who waited? Who benefits? Who pays? Who gets protected by uncertainty, and who is told to be patient while the consequences arrive?`,
    `The strongest details in the source set are these: ${factPack.confirmed.slice(0, 3).join(" ")} The weak spots are just as important: ${factPack.unclear.slice(0, 2).join(" ")} Missing information is not neutral when ordinary people are the ones asked to absorb the risk.`,
    `The demand should be simple and fair: show the evidence, name the decision-makers, explain the costs, and make the affected public whole where harm has been done. Trust is not a press release. It is a debt paid in answers.`
  ]);
}

function historicalTake(agent, factPack) {
  const style = agent.style || {};
  const motif =
    style.moralRegister >= style.economicRegister
      ? "duty, judgment, and the moral habits of a political community"
      : "property, labor, exchange, and the bargain beneath public order";
  const vocabulary = style.vocabulary?.slice(0, 5).join(", ");
  return article([
    `The present always believes its emergencies are new. Often they are only old questions wearing modern clothes. The facts in front of us are these: ${factPack.whatHappened}`,
    `${detailSentence(factPack)} The older question is whether a society can recognize consequence before it becomes crisis. The instruments change; the pattern of power, fear, interest, duty, and self-justification often does not.`,
    `The source set leaves room for caution. ${factPack.unclear.slice(0, 2).join(" ")} A serious historical analogy should not fill those gaps with fantasy. It should ask what kind of order produces the gaps, who is protected by ambiguity, and what virtues would be required to answer honestly.`,
    `${vocabulary ? `The creator-provided style profile points toward terms such as ${vocabulary}, which bends the reading toward ${motif}. ` : ""}The current story will matter beyond the day if it reveals a durable weakness in judgment, accountability, or public memory.`
  ]);
}

function detailSentence(factPack) {
  const actors = factPack.who.length ? `Key named actors include ${factPack.who.slice(0, 4).join(", ")}.` : "The source set does not surface many clear named actors.";
  const places = factPack.where.length ? ` Places named in the reporting include ${factPack.where.slice(0, 3).join(", ")}.` : "";
  const sources = factPack.sourceDossiers.length ? ` The local dossier draws from ${factPack.sourceDossiers.map((source) => source.source).join(", ")}.` : "";
  return `${actors}${places}${sources}`;
}

function article(paragraphs) {
  return paragraphs.filter(Boolean).join("\n\n");
}

function hash(value) {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = Math.imul(31, h) + value.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(36);
}

const placeWords = [
  "America",
  "U.S",
  "United",
  "Europe",
  "China",
  "Russia",
  "Ukraine",
  "Gaza",
  "Israel",
  "Britain",
  "London",
  "Washington",
  "New York",
  "California",
  "Texas",
  "Venezuela",
  "Germany",
  "Iran",
  "France",
  "Canada",
  "Japan",
  "India"
];
