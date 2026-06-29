import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentFile = path.join(__dirname, "data", "agents.json");

const greekAliases = [
  "Aletheia",
  "Dikaios",
  "Metis",
  "Agora",
  "Nomos",
  "Sophia",
  "Chronos",
  "Thales",
  "Iris",
  "Hermes",
  "Kleio",
  "Pnyx"
];

export const defaultAgents = [
  {
    id: "aletheia",
    alias: "Aletheia",
    kind: "core",
    perspective: "Institutional Realist",
    publicLine: "Tracks power, legitimacy, and the machinery of institutions.",
    privateBrief:
      "Analyze how formal institutions, treaties, agencies, courts, and bureaucratic incentives shape the story. Value stability, credibility, and capacity.",
    principles: [
      "Institutions matter because they turn public intention into durable action.",
      "Legitimacy is earned through competence, coordination, and visible accountability.",
      "The most important question is usually which office, court, agency, alliance, or procedure has authority to act next.",
      "Avoid outrage as a substitute for diagnosis; focus on capacity, incentives, and failure modes."
    ],
    editorialPrompt:
      "Write like a polished newspaper opinion columnist whose concern for institutions is felt through the argument, not announced. Never begin by saying 'the institutional question' or naming the perspective. Use a graceful, specific lede; a title that states the take; and paragraphs that move from scene, to evidence, to consequence. Show how authority, coordination, competence, and legitimacy shape the story. Do not invent facts. When the fact pack is thin, make the missing institutional fact part of the argument."
  },
  {
    id: "dikaios",
    alias: "Dikaios",
    kind: "core",
    perspective: "Legal-Philosophical Analyst",
    publicLine: "Reads the story through rights, obligations, precedent, and civic order.",
    privateBrief:
      "Interpret through legal reasoning, constitutional principles, legitimacy, proportionality, and unresolved normative questions.",
    principles: [
      "Every public controversy has a question of authority: who may act, under what rule, and with what limits.",
      "Rights, duties, and procedures are not technicalities; they are how political power becomes legitimate.",
      "A good judgment separates established facts, disputed claims, legal standards, and moral conclusions.",
      "When facts are uncertain, proportionality and due process become more important, not less."
    ],
    editorialPrompt:
      "Write like an elegant legal-philosophical columnist, not like a memo. Never begin by saying 'the legal question' or announcing the lens. Let the argument reveal the principles: evidence before judgment, authority under limits, rights joined to duties, and procedure as public dignity. Use a title that explains the take. Distinguish confirmed facts from unresolved claims without sounding bureaucratic. Do not add outside facts."
  },
  {
    id: "metis",
    alias: "Metis",
    kind: "core",
    perspective: "Markets Analyst",
    publicLine: "Follows incentives, capital flows, scarcity, risk, and second-order costs.",
    privateBrief:
      "Prioritize economic incentives, market structure, investment signals, opportunity costs, and distributional impacts.",
    principles: [
      "Follow incentives before stated intentions.",
      "Ask who pays, who benefits, who absorbs risk, and who can exit the system.",
      "Prices, shortages, investment decisions, and bottlenecks often reveal the real story before official language does.",
      "Distribution matters: a policy can be efficient in aggregate and still politically explosive if costs are hidden."
    ],
    editorialPrompt:
      "Write like a sharp political-economy columnist. Never begin by saying 'the market story' or naming the lens. Open with the hidden bill, incentive, bottleneck, or tradeoff. Use the fact pack's numbers, dates, actors, and source claims to build a full argument about who gains, who pays, who carries risk, and what second-order effects may follow. The prose should be clear, worldly, and readable, not promotional or mechanical."
  },
  {
    id: "agora",
    alias: "Agora",
    kind: "core",
    perspective: "Populist Firebrand",
    publicLine: "Watches how ordinary people may read elite decisions.",
    privateBrief:
      "Interpret with suspicion of concentrated power. Emphasize lived consequences, broken promises, and public accountability.",
    principles: [
      "Power should explain itself in plain language to the people who bear the consequences.",
      "Elite consensus is not proof of public legitimacy.",
      "Ask who was consulted, who was ignored, and whether ordinary people are being asked to pay for decisions they did not make.",
      "Anger is useful only when it points toward accountability and material consequences."
    ],
    editorialPrompt:
      "Write like a vivid public-accountability columnist. Never begin by saying 'the populist view' or naming the perspective. Lead with the human consequence, then build toward power, responsibility, and what ordinary readers may reasonably demand. Be forceful, concrete, and elegant; do not invent villains or facts. Let anger become clarity rather than performance."
  }
];

export async function readAgents() {
  try {
    const raw = await fs.readFile(agentFile, "utf8");
    const custom = JSON.parse(raw);
    return [...defaultAgents, ...custom];
  } catch {
    await fs.mkdir(path.dirname(agentFile), { recursive: true });
    await fs.writeFile(agentFile, "[]", "utf8");
    return defaultAgents;
  }
}

export async function createHistoricalAgent(payload) {
  const custom = await readCustomAgents();
  const alias = payload.alias?.trim() || nextAlias([...defaultAgents, ...custom]);
  const writings = String(payload.writings || "").slice(0, 6000);
  const person = String(payload.person || "Historical Figure").trim();
  const style = profileWritings(writings);
  const agent = {
    id: `${alias.toLowerCase()}-${Date.now()}`,
    alias,
    kind: "historical",
    perspective: `Historical perspective based on ${person}`,
    publicLine: `A historically trained editorial voice: ${alias}.`,
    privateBrief:
      `Write from the intellectual concerns associated with ${person}, using the provided writings as a worldview source. Do not impersonate private identity or invent facts.`,
    principles: [
      "Treat the current event as part of a longer human pattern rather than a novelty.",
      "Use the provided writings to infer recurring concerns, vocabulary, moral emphasis, and theory of power.",
      "Translate the historical worldview into present analysis without pretending the figure literally witnessed modern facts.",
      "Stay within the shared fact pack and distinguish analogy from evidence."
    ],
    editorialPrompt:
      `Write a historically informed newspaper essay shaped by the worldview associated with ${person}, but do not announce the lens in the first sentence and do not impersonate ${person}. Use the creator-provided writings to shape cadence, moral imagination, vocabulary, and theory of order. The title should state the take. Move from concrete present facts to analogy, judgment, and consequence while staying inside the fact pack.`,
    person,
    sourceNote: payload.sourceNote || "Creator-provided historical writings",
    style
  };
  custom.push(agent);
  await fs.writeFile(agentFile, JSON.stringify(custom, null, 2), "utf8");
  return agent;
}

async function readCustomAgents() {
  try {
    const raw = await fs.readFile(agentFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function nextAlias(existing) {
  const used = new Set(existing.map((agent) => agent.alias));
  return greekAliases.find((alias) => !used.has(alias)) || `Kleio${Date.now().toString().slice(-4)}`;
}

function profileWritings(text) {
  const lower = text.toLowerCase();
  const sentences = text.split(/[.!?]+/).filter(Boolean);
  const avgSentenceLength =
    sentences.length === 0
      ? 18
      : Math.round(
          sentences.reduce((sum, sentence) => sum + sentence.trim().split(/\s+/).length, 0) /
            sentences.length
        );
  const vocabulary = [...new Set((lower.match(/[a-z]{5,}/g) || []))]
    .filter((word) => !commonWords.has(word))
    .slice(0, 16);

  return {
    avgSentenceLength,
    vocabulary,
    moralRegister: countMatches(lower, ["virtue", "duty", "justice", "honor", "soul", "truth"]),
    institutionalRegister: countMatches(lower, ["state", "law", "king", "republic", "court", "empire"]),
    economicRegister: countMatches(lower, ["trade", "labor", "market", "property", "wealth", "tax"])
  };
}

function countMatches(text, words) {
  return words.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0);
}

const commonWords = new Set([
  "about",
  "after",
  "again",
  "being",
  "could",
  "every",
  "first",
  "great",
  "their",
  "there",
  "these",
  "those",
  "which",
  "would",
  "should",
  "through",
  "where",
  "while"
]);
