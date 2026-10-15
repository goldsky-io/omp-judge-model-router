// Routes each main-session user turn to one of three tiers: @smol, @default, or
// @slow (when those roles resolve). An OpenRouter decision model (Jev) picks the
// tier. Thinking effort stays with omp's built-in `defaultThinkingLevel: auto`,
// which pi.setModel preserves.

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const DECISION_MODEL = process.env.JEV_ROUTER_MODEL || "~typesafe/jev-latest";
const MAX_PROMPT_CHARS = 8000; // ponytail: head-only truncation; Jev context is ~32k tokens
const TIERS: Record<string, string> = {
  smol: "Trivial or mechanical turn: a lookup, a rename, a one-line edit, a short factual answer, or casual chat.",
  default: "Ordinary coding turn: implement or change a feature, fix a clear bug, write tests or docs.",
  slow: "Hard turn: open-ended design, a subtle bug with no clear cause, a large refactor, or deep multi-step reasoning.",
};

const key = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

export default function (pi) {
  let home; // fallback "default" tier: the first non-tier model this session ran on
  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.agent && ctx.agent.kind !== "main") return; // subagents keep their own model
    const prompt = (event.prompt ?? "").trim();
    const current = ctx.models.current();
    if (!prompt || !current) return;

    const models = new Map<string, any>();
    for (const tier of ["smol", "default", "slow"]) {
      const m = ctx.models.resolve(`@${tier}`);
      if (m) models.set(tier, m);
    }
    // resolve() misses aliases such as `claude-opus-latest`, so `@default` can fail.
    if (!models.has("default")) {
      if (!home && ![...models.values()].some((m) => key(m) === key(current))) home = current;
      if (home) models.set("default", home);
    }
    // A model picked by hand (outside the tiers) stays until you pick a tier model again.
    if (models.size < 2 || ![...models.values()].some((m) => key(m) === key(current))) return;

    const notify = (msg: string, level: string) => ctx.hasUI && ctx.ui.notify(msg, level);
    try {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
      if (!apiKey) return notify("jev-router: no OpenRouter API key; routing skipped", "warning");
      const res = await fetch(DECISIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: DECISION_MODEL,
          state: { user_turn: prompt.slice(0, MAX_PROMPT_CHARS) },
          questions: {
            tier: {
              type: "choice",
              instructions: "Pick the cheapest model tier that can handle this coding-agent turn well.",
              criteria: Object.fromEntries([...models.keys()].map((t) => [t, TIERS[t]])),
            },
          },
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const answer = (await res.json()).answers?.tier;
      const target = models.get(answer?.choice);
      if (!target || key(target) === key(current)) return;
      if (await pi.setModel(target)) {
        notify(`jev-router: ${answer.choice} → ${key(target)} (${Math.round((answer.confidence ?? 1) * 100)}%)`, "info");
      }
    } catch (err) {
      notify(`jev-router: routing skipped (${err instanceof Error ? err.message : err})`, "warning");
    }
  });
}
