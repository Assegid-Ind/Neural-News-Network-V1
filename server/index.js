import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIssue } from "./newsEngine.js";
import { createHistoricalAgent, readAgents } from "./agents.js";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadLocalEnv(path.join(__dirname, "..", ".env"));
const port = Number(process.env.PORT || process.env.NNN_PORT || 4177);
const creatorKey = process.env.CREATOR_KEY || "creator";
let issueCache = null;
let cacheTime = 0;
const cacheMs = Number(process.env.NNN_REFRESH_MS || 1000 * 60 * 8);

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, generatedAt: new Date().toISOString() });
});

app.get("/api/issue", async (req, res) => {
  try {
    const requestedForce = req.query.force === "1";
    const creatorAuthorized = req.headers["x-creator-key"] === creatorKey;
    const force = requestedForce && creatorAuthorized;
    if (!issueCache || force || Date.now() - cacheTime > cacheMs) {
      const agents = await readAgents();
      issueCache = await buildIssue(agents, { refreshEveryMs: cacheMs });
      cacheTime = Date.now();
    }
    res.json({
      ...issueCache,
      refreshLocked: !creatorAuthorized,
      forceIgnored: requestedForce && !creatorAuthorized
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/agents", async (req, res) => {
  const reveal = req.headers["x-creator-key"] === creatorKey;
  const agents = await readAgents();
  res.json(
    agents.map((agent) => ({
      id: agent.id,
      alias: agent.alias,
      kind: agent.kind,
      publicLine: agent.publicLine,
      person: reveal ? agent.person : undefined,
      perspective: reveal ? agent.perspective : undefined,
      privateBrief: reveal ? agent.privateBrief : undefined,
      principles: reveal ? agent.principles : undefined,
      editorialPrompt: reveal ? agent.editorialPrompt : undefined,
      sourceNote: reveal ? agent.sourceNote : undefined,
      style: reveal ? agent.style : undefined
    }))
  );
});

app.post("/api/agents/historical", async (req, res) => {
  if (req.headers["x-creator-key"] !== creatorKey) {
    res.status(401).json({ error: "Creator key required" });
    return;
  }
  if (!req.body?.person || !req.body?.writings) {
    res.status(400).json({ error: "person and writings are required" });
    return;
  }
  const agent = await createHistoricalAgent(req.body);
  issueCache = null;
  res.status(201).json(agent);
});

const distDir = path.join(__dirname, "..", "dist");
app.use(express.static(distDir));

app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Neural News Network running on port ${port}`);
});

function loadLocalEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}
