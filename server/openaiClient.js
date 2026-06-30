const openAiEndpoint = "https://api.openai.com/v1/responses";
let disabledReason = "";
let disabledUntil = 0;

export function hasOpenAiKey() {
  if (disabledUntil && Date.now() > disabledUntil) {
    disabledReason = "";
    disabledUntil = 0;
  }
  return Boolean(process.env.OPENAI_API_KEY) && !disabledReason;
}

export function openAiStatus() {
  return {
    configured: Boolean(process.env.OPENAI_API_KEY),
    available: hasOpenAiKey(),
    disabled: Boolean(disabledReason)
  };
}

export async function generatePerspectiveArticle(agent, factPack) {
  if (!hasOpenAiKey()) return null;

  const response = await fetch(openAiEndpoint, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: systemPrompt(agent)
        },
        {
          role: "user",
          content: JSON.stringify({
            assignment:
              "Write one finished newspaper-style opinion analysis using only this fact pack. Return JSON only.",
            agent: {
              alias: agent.alias,
              publicLine: agent.publicLine,
              hiddenPerspective: agent.perspective,
              privateBrief: agent.privateBrief,
              principles: agent.principles,
              editorialPrompt: agent.editorialPrompt,
              person: agent.person,
              sourceNote: agent.sourceNote,
              style: agent.style
            },
            factPack: compactFactPack(factPack)
          })
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "editorial_perspective",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["headline", "dek", "body", "uncertaintyNote"],
            properties: {
              headline: {
                type: "string",
                description: "A sharp article title that states the take without naming the agent alias."
              },
              dek: {
                type: "string",
                description: "One elegant sentence summarizing the argument."
              },
              body: {
                type: "string",
                description:
                  "A finished 650-900 word article in paragraphs separated by blank lines. No bullets."
              },
              uncertaintyNote: {
                type: "string",
                description: "One sentence naming what is still unclear or weakly sourced."
              }
            }
          }
        }
      },
      temperature: Number(process.env.OPENAI_TEMPERATURE || 0.78),
      max_output_tokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 1400)
    }),
    signal: AbortSignal.timeout(Number(process.env.OPENAI_TIMEOUT_MS || 45000))
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI request failed with ${response.status}`;
    if (isConfigurationFailure(response.status, message)) {
      disabledReason = message;
      disabledUntil = Date.now() + Number(process.env.OPENAI_RETRY_DISABLED_MS || 1000 * 60 * 15);
    }
    throw new Error(message);
  }

  const parsed = parseResponseJson(data);
  if (!parsed?.headline || !parsed?.body) {
    throw new Error("OpenAI response did not include a valid article.");
  }
  return {
    headline: cleanGeneratedText(parsed.headline).slice(0, 160),
    dek: cleanGeneratedText(parsed.dek || "").slice(0, 260),
    body: cleanGeneratedText(parsed.body),
    uncertaintyNote: cleanGeneratedText(parsed.uncertaintyNote || "")
  };
}

function isConfigurationFailure(status, message) {
  return (
    status === 401 ||
    status === 403 ||
    /quota|billing|invalid api key|incorrect api key|project/i.test(message)
  );
}

function systemPrompt(agent) {
  return [
    "You are an excellent newspaper opinion writer inside Neural News Network.",
    "Your job is to transform a neutral fact pack into a beautifully written, source-grounded editorial article.",
    "",
    "Hard rules:",
    "- Use only the facts, claims, sources, dates, numbers, and uncertainty provided in the fact pack.",
    "- Do not add outside facts, background, quotes, statistics, names, motives, or chronology.",
    "- If the fact pack is thin, make that limitation part of the argument instead of filling the gap.",
    "- Do not write like a chatbot. Do not explain your process. Do not mention 'fact pack'.",
    "- Do not begin by naming the perspective, the agent, or phrases like 'from an institutional view'.",
    "- The hidden perspective is private. Let it guide judgment, emphasis, rhythm, and questions; do not label it.",
    "- The public sees only the Greek alias.",
    "",
    "Article craft:",
    "- Write with a real lede, pressure, elegance, and a clear argumentative arc.",
    "- The headline should grab and clarify the take.",
    "- Use concrete details from the source dossier: actors, dates, numbers, places, sequence, disputes, and open questions.",
    "- Make salient points, not generic commentary.",
    "- Prefer graceful paragraphs over formulaic sections.",
    "- End with a memorable, restrained final sentence.",
    "",
    "Agent guidance:",
    `Alias: ${agent.alias}`,
    `Hidden perspective: ${agent.perspective}`,
    `Private brief: ${agent.privateBrief || ""}`,
    `Principles: ${(agent.principles || []).join(" ")}`,
    `Editorial prompt: ${agent.editorialPrompt || ""}`
  ].join("\n");
}

function compactFactPack(factPack) {
  return {
    headline: factPack.headline,
    summary: factPack.summary,
    topic: factPack.topic,
    whatHappened: factPack.whatHappened,
    who: factPack.who,
    where: factPack.where,
    when: factPack.when,
    confirmed: factPack.confirmed,
    disputed: factPack.disputed,
    unclear: factPack.unclear,
    importantNumbers: factPack.importantNumbers,
    context: factPack.context,
    stakes: factPack.stakes,
    timeline: factPack.timeline,
    evidence: factPack.evidence,
    sourceDossiers: factPack.sourceDossiers.map((source) => ({
      source: source.source,
      headline: source.headline,
      link: source.link,
      publishedAt: source.publishedAt,
      author: source.author,
      summary: source.summary,
      excerpt: source.excerpt,
      claims: source.claims.slice(0, 4),
      numbers: source.numbers.slice(0, 8),
      extractionStatus: source.extractionStatus
    })),
    sourceLinks: factPack.sourceLinks,
    extraction: factPack.extraction
  };
}

function parseResponseJson(data) {
  const directText = data.output_text || findOutputText(data.output);
  if (!directText) return null;
  try {
    return JSON.parse(directText);
  } catch {
    const match = directText.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

function findOutputText(output) {
  if (!Array.isArray(output)) return "";
  return output
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function cleanGeneratedText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
