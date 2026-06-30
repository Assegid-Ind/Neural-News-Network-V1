import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  Eye,
  KeyRound,
  RefreshCcw,
  Search,
  UserPlus
} from "lucide-react";
import "./styles.css";

const dateFormat = new Intl.DateTimeFormat("en", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric"
});

const timeFormat = new Intl.DateTimeFormat("en", {
  hour: "numeric",
  minute: "2-digit"
});

function App() {
  const [issue, setIssue] = useState(null);
  const [agents, setAgents] = useState([]);
  const [activeStoryId, setActiveStoryId] = useState(() => readStoryHash());
  const [creatorKey, setCreatorKey] = useState(localStorage.getItem("nnn.creatorKey") || "");
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const creatorUnlocked = agents.some((agent) => agent.perspective);

  async function loadIssue(force = false) {
    setError("");
    setLoading(true);
    try {
      const response = await fetch(`/api/issue${force ? "?force=1" : ""}`, {
        headers: force && creatorKey ? { "x-creator-key": creatorKey } : {}
      });
      if (!response.ok) throw new Error("The newsroom could not publish a fresh issue.");
      const data = await response.json();
      setIssue(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadAgents(key = creatorKey) {
    const response = await fetch("/api/agents", {
      headers: key ? { "x-creator-key": key } : {}
    });
    setAgents(await response.json());
  }

  useEffect(() => {
    loadIssue();
    loadAgents();
  }, []);

  useEffect(() => {
    if (!issue?.refreshEveryMs) return undefined;
    const timer = window.setInterval(() => loadIssue(false), issue.refreshEveryMs);
    return () => window.clearInterval(timer);
  }, [issue?.refreshEveryMs]);

  useEffect(() => {
    function syncRoute() {
      setActiveStoryId(readStoryHash());
    }
    window.addEventListener("hashchange", syncRoute);
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

  const activeStory = useMemo(
    () => issue?.stories?.find((story) => story.id === activeStoryId) || null,
    [issue, activeStoryId]
  );

  const topics = useMemo(() => {
    const all = issue?.stories?.map((story) => story.topic) || [];
    return ["Top Stories", ...Array.from(new Set(all))];
  }, [issue]);

  function chooseTopic(topic) {
    if (activeStoryId) {
      setActiveStoryId(null);
      window.history.pushState("", document.title, window.location.pathname + window.location.search);
    }
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  function openStory(id) {
    setActiveStoryId(id);
    window.location.hash = `story/${encodeURIComponent(id)}`;
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  function goHome() {
    setActiveStoryId(null);
    window.history.pushState("", document.title, window.location.pathname + window.location.search);
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  function unlockCreator(event) {
    event.preventDefault();
    localStorage.setItem("nnn.creatorKey", creatorKey);
    loadAgents(creatorKey);
  }

  async function addHistoricalAgent(agent) {
    const response = await fetch("/api/agents/historical", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-creator-key": creatorKey
      },
      body: JSON.stringify(agent)
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Could not create agent.");
    }
    await loadAgents(creatorKey);
    await loadIssue(false);
  }

  return (
    <main className="page-shell">
      <Header
        generatedAt={issue?.generatedAt}
        loading={loading}
        onRefresh={() => loadIssue(true)}
        creatorOpen={creatorOpen}
        setCreatorOpen={setCreatorOpen}
        compact={!!activeStory}
        creatorUnlocked={creatorUnlocked}
      />

      {!activeStory && (
        <nav className="section-nav" aria-label="News sections">
          {topics.map((topic) => (
            <button key={topic} onClick={() => chooseTopic(topic)}>
              {topic}
            </button>
          ))}
        </nav>
      )}

      {error && <div className="error-banner">{error}</div>}

      {creatorOpen && (
        <CreatorConsole
          agents={agents}
          creatorKey={creatorKey}
          setCreatorKey={setCreatorKey}
          onUnlock={unlockCreator}
          onAddHistoricalAgent={addHistoricalAgent}
        />
      )}

      {activeStory ? (
        <StoryReader story={activeStory} onBack={goHome} />
      ) : issue ? (
        <FrontPage
          issue={issue}
          onSelect={openStory}
        />
      ) : (
        <section className="empty-state">Publishing the first edition...</section>
      )}
    </main>
  );
}

function Header({ generatedAt, loading, onRefresh, creatorOpen, setCreatorOpen, compact, creatorUnlocked }) {
  const generated = generatedAt ? new Date(generatedAt) : null;
  return (
    <header className={compact ? "site-header compact" : "site-header"}>
      <div className="utility-row">
        <span>{dateFormat.format(new Date())}</span>
        <span className="status">
          <Clock3 size={15} />
          {generated ? `Updated ${timeFormat.format(generated)}` : "Preparing edition"}
        </span>
        <div className="utility-actions">
          <button className="ghost-button" aria-label="Search">
            <Search size={16} />
          </button>
          {creatorUnlocked && (
            <button className="ghost-button" onClick={onRefresh} disabled={loading}>
              <RefreshCcw size={16} className={loading ? "spin" : ""} />
              Refresh
            </button>
          )}
          <button
            className={creatorOpen ? "ghost-button active" : "ghost-button"}
            onClick={() => setCreatorOpen(!creatorOpen)}
          >
            <KeyRound size={16} />
            Creator
          </button>
        </div>
      </div>
      <div className="masthead">Neural News Network</div>
    </header>
  );
}

function FrontPage({ issue, onSelect }) {
  const stories = issue?.stories || [];
  const lead = stories[0];
  const secondary = stories.slice(1, 4);
  const latest = stories.slice(4, 10);
  const mostRead = [...stories].sort((a, b) => b.heat - a.heat).slice(0, 5);

  if (!lead) {
    return (
      <section className="front-grid loading">
        <div>Gathering today&apos;s stories...</div>
      </section>
    );
  }

  return (
    <section className="front-grid">
      <button className="lead-story" onClick={() => onSelect(lead.id)}>
        <StoryImage topic={lead.topic} />
        <span className="section-kicker">{lead.topic}</span>
        <h1>{lead.headline}</h1>
        <p>{lead.deck}</p>
        <SourceLine story={lead} />
      </button>

      <div className="secondary-stack">
        {secondary.map((story) => (
          <StoryTeaser
            key={story.id}
            story={story}
            onSelect={onSelect}
          />
        ))}
      </div>

      <aside className="right-rail">
        <h2>Latest</h2>
        {latest.map((story) => (
          <button key={story.id} onClick={() => onSelect(story.id)}>
            <span>{story.topic}</span>
            <strong>{story.headline}</strong>
          </button>
        ))}
      </aside>

      <section className="briefing-list">
        <div className="section-title">
          <h2>The Briefing</h2>
          <span>{stories.length} developing stories</span>
        </div>
        <div className="briefing-grid">
          {stories.slice(0, 12).map((story) => (
            <StoryCard key={story.id} story={story} onSelect={onSelect} />
          ))}
        </div>
      </section>

      <aside className="most-read">
        <h2>Most Signaled</h2>
        {mostRead.map((story, index) => (
          <button key={story.id} onClick={() => onSelect(story.id)}>
            <span>{index + 1}</span>
            <strong>{story.headline}</strong>
          </button>
        ))}
      </aside>
    </section>
  );
}

function StoryImage({ topic }) {
  const imageMap = {
    World: "https://images.unsplash.com/photo-1521295121783-8a321d551ad2?auto=format&fit=crop&w=900&q=80",
    National: "https://images.unsplash.com/photo-1565120130276-dfbd9a7a3ad7?auto=format&fit=crop&w=900&q=80",
    Technology: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=900&q=80",
    Economy: "https://images.unsplash.com/photo-1520607162513-77705c0f0d4a?auto=format&fit=crop&w=900&q=80",
    Science: "https://images.unsplash.com/photo-1532094349884-543bc11b234d?auto=format&fit=crop&w=900&q=80",
    Law: "https://images.unsplash.com/photo-1589578228447-e1a4e481c6c8?auto=format&fit=crop&w=900&q=80"
  };
  return <img src={imageMap[topic] || imageMap.World} alt="" />;
}

function StoryTeaser({ story, onSelect }) {
  return (
    <button className="story-teaser" onClick={() => onSelect(story.id)}>
      <span className="section-kicker">{story.topic}</span>
      <h2>{story.headline}</h2>
      <p>{story.deck}</p>
      <SourceLine story={story} />
    </button>
  );
}

function StoryCard({ story, onSelect }) {
  return (
    <button className="story-card" onClick={() => onSelect(story.id)}>
      <span className="section-kicker">{story.topic}</span>
      <h3>{story.headline}</h3>
      <p>{story.deck}</p>
      <SourceLine story={story} />
    </button>
  );
}

function SourceLine({ story }) {
  return (
    <span className="source-line">
      {story.sources.length} source{story.sources.length === 1 ? "" : "s"}
      <ChevronRight size={14} />
      {story.sources.slice(0, 2).map((source) => source.source).join(", ")}
    </span>
  );
}

function StoryReader({ story, onBack }) {
  return (
    <article className="story-reader" id="story-reader">
      <div className="reader-main">
        <button className="back-button" onClick={onBack}>
          <ArrowLeft size={17} />
          Back to Home
        </button>
        <span className="section-kicker">{story.topic}</span>
        <h1>{story.headline}</h1>
        <p className="reader-deck">{story.deck}</p>

        <section className="analysis-section">
          <div className="section-title">
            <h2>Analysis</h2>
            <span>Four views, one source set</span>
          </div>
          <div className="analysis-grid">
            {story.perspectives.map((view) => (
              <div className="analysis-card" key={view.agentId}>
                <span className="analysis-alias">{view.alias}</span>
                <h3>{view.headline.replace(`${view.alias}: `, "")}</h3>
                {view.dek ? <p className="analysis-dek">{view.dek}</p> : null}
                <RichText text={view.body} />
                {view.uncertaintyNote ? <small>{view.uncertaintyNote}</small> : null}
              </div>
            ))}
          </div>
        </section>
      </div>

      <aside className="source-panel">
        <h2>Sources</h2>
        {story.sources.map((source) => (
          <a key={`${source.source}-${source.headline}`} href={source.link || "#"} target="_blank" rel="noreferrer">
            <span>{source.source}</span>
            <strong>{source.headline}</strong>
            <ExternalLink size={15} />
          </a>
        ))}
        <p>
          Updated from linked reports. Interpretive sections are constrained to this source set.
        </p>
      </aside>
    </article>
  );
}

function RichText({ text }) {
  return String(text || "")
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((paragraph, index) => (
      <p key={index}>{paragraph}</p>
    ));
}

function readStoryHash() {
  const match = window.location.hash.match(/^#story\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function CreatorConsole({ agents, creatorKey, setCreatorKey, onUnlock, onAddHistoricalAgent }) {
  const [form, setForm] = useState({ alias: "", person: "", sourceNote: "", writings: "" });
  const [message, setMessage] = useState("");
  const revealed = agents.some((agent) => agent.perspective);

  async function submit(event) {
    event.preventDefault();
    setMessage("Adding historical voice...");
    try {
      await onAddHistoricalAgent(form);
      setForm({ alias: "", person: "", sourceNote: "", writings: "" });
      setMessage("Historical voice added.");
    } catch (err) {
      setMessage(err.message);
    }
  }

  return (
    <section className="creator-console">
      <form className="unlock" onSubmit={onUnlock}>
        <label>
          Creator key
          <input value={creatorKey} onChange={(event) => setCreatorKey(event.target.value)} placeholder="default: creator" />
        </label>
        <button><Eye size={16} /> Reveal setup</button>
      </form>

      <div className="agent-ledger">
        {agents.map((agent) => (
          <div key={agent.id}>
            <span>{agent.alias}</span>
            <p>{agent.publicLine}</p>
            {revealed && (
              <small>
                Hidden perspective: <strong>{agent.perspective}</strong>
                {agent.privateBrief ? ` / ${agent.privateBrief}` : ""}
              </small>
            )}
          </div>
        ))}
      </div>

      {revealed && (
        <form className="historical-form" onSubmit={submit}>
          <h3><UserPlus size={17} /> Add Historical Voice</h3>
          <input
            value={form.alias}
            onChange={(event) => setForm({ ...form, alias: event.target.value })}
            placeholder="Greek alias, optional"
          />
          <input
            value={form.person}
            onChange={(event) => setForm({ ...form, person: event.target.value })}
            placeholder="Historical figure"
            required
          />
          <input
            value={form.sourceNote}
            onChange={(event) => setForm({ ...form, sourceNote: event.target.value })}
            placeholder="Source note"
          />
          <textarea
            value={form.writings}
            onChange={(event) => setForm({ ...form, writings: event.target.value })}
            placeholder="Paste public-domain writings or notes that define the worldview."
            required
          />
          <button>Add voice</button>
          {message && <p className="console-message">{message}</p>}
        </form>
      )}
    </section>
  );
}

createRoot(document.getElementById("root")).render(<App />);
