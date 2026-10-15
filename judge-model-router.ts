// Picks the model and the thinking effort for the main session with a judge
// (decision) model. Any judge model in omp's catalog works: OpenRouter Decisions,
// TypeSafe, Cloudflare Workers AI, or OpenAI Decisions.
//
// - Each user prompt: one judge request picks the tier (@smol, @default, @slow)
//   and the effort. Setting an explicit effort turns off omp's built-in `auto`
//   classifier for the session, so the prompt costs one judge request, not two.
// - Each later step of the tool loop: one judge request re-picks only the effort,
//   from the latest tool calls and results. The model stays fixed within a prompt.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createNativeJudge, isJudgmentApi } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-ai";

const DEFAULT_JUDGE = "openrouter/~typesafe/jev-latest";
// ponytail: fixed to the default profile's agent dir; named profiles share this file.
const CONFIG_FILE = path.join(os.homedir(), ".omp", "agent", "judge-model-router.json");
// These providers serve only judge models, so they are missing from getAll().
const JUDGE_ONLY_PROVIDERS = ["typesafe", "cloudflare-workers-ai"];
const MAX_STATE_CHARS = 8000; // ponytail: head-only truncation; Jev context is ~32k tokens
const RECENT_MESSAGES = 6;
const TIERS: Record<string, string> = {
  smol: "Trivial or mechanical turn: a lookup, a rename, a one-line edit, a short factual answer, or casual chat.",
  default: "Ordinary coding turn: implement or change a feature, fix a clear bug, write tests or docs.",
  slow: "Hard turn: open-ended design, a subtle bug with no clear cause, a large refactor, or deep multi-step reasoning.",
};
// `max` is reserved for the `ultrathink` keyword, as in omp's built-in classifier.
const EFFORTS: Record<string, string> = {
  low: "Routine: read, search, run a command, or make an obvious edit.",
  medium: "Some reasoning: a small change that must fit existing code, or reading an unclear result.",
  high: "Careful reasoning: a non-obvious fix, a failing test or error to diagnose, or code that must be correct.",
  xhigh: "Deep reasoning: design, a subtle or repeated failure, concurrency, security, or many interacting parts.",
};

const key = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

function judgeSelector(): string {
  if (process.env.JUDGE_ROUTER_MODEL) return process.env.JUDGE_ROUTER_MODEL;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")).judge || DEFAULT_JUDGE;
  } catch {
    return DEFAULT_JUDGE;
  }
}

/** `provider/id` → catalog judge model, or undefined when the selector names no judge model. */
function findJudge(registry, selector: string): Model | undefined {
  const slash = selector.indexOf("/");
  const model = slash > 0 ? registry.find(selector.slice(0, slash), selector.slice(slash + 1)) : undefined;
  return model && isJudgmentApi(model.api) ? model : undefined;
}

/** Sends one judgment to the selected judge model; throws on any failure. */
async function ask(ctx, state: unknown, questions: Record<string, unknown>) {
  const selector = judgeSelector();
  const model = findJudge(ctx.modelRegistry, selector);
  if (!model) throw new Error(`${selector} is not a judge model`);
  const apiKey = await ctx.modelRegistry.getApiKey(model);
  if (!apiKey) throw new Error(`no ${model.provider} credential for ${selector}`);
  const result = await createNativeJudge(model, { apiKey }).judge(
    { state, questions },
    { signal: AbortSignal.timeout(8000) },
  );
  return result.answers;
}

/** Text of the latest messages, newest last: assistant text and tool calls, tool results. */
function recentSteps(messages): string {
  const lines: string[] = [];
  for (const m of messages.slice(-RECENT_MESSAGES)) {
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
    for (const p of parts) {
      if (p.type === "text") lines.push(`${m.role}${m.isError ? " (error)" : ""}: ${p.text.slice(0, 1500)}`);
      if (p.type === "toolCall") lines.push(`tool call ${p.name}: ${JSON.stringify(p.arguments).slice(0, 300)}`);
    }
  }
  return lines.join("\n").slice(-MAX_STATE_CHARS);
}

export default function (pi) {
  pi.registerCommand("judge-router", {
    description: "Show or set the decision model that routes each turn",
    handler: async (args, ctx) => {
      const registry = ctx.modelRegistry;
      let selector = args.trim();
      if (!selector) {
        const options: string[] = [];
        for (const provider of new Set([...registry.getAll().map((m) => m.provider), ...JUDGE_ONLY_PROVIDERS])) {
          const judges = (registry.getProviderModels(provider) ?? []).filter((m) => isJudgmentApi(m.api));
          if (judges.length && (await registry.getApiKey(judges[0]))) options.push(...judges.map(key));
        }
        selector = (await ctx.ui.select(`Decision model (current: ${judgeSelector()})`, options)) ?? "";
        if (!selector) return;
      }
      if (!findJudge(registry, selector)) {
        ctx.ui.notify(`judge-router: ${selector} is not a judge model`, "error");
        return;
      }
      fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
      fs.writeFileSync(CONFIG_FILE, `${JSON.stringify({ judge: selector }, null, 2)}\n`);
      const shadowed = process.env.JUDGE_ROUTER_MODEL ? " (JUDGE_ROUTER_MODEL still overrides it)" : "";
      ctx.ui.notify(`judge-router: decision model set to ${selector}${shadowed}`, "info");
    },
  });

  let home: Model | undefined; // fallback "default" tier: the first non-tier model this session ran on
  let task = ""; // the latest user prompt, for per-step judgments
  let ultrathink = false;
  let skipNextStep = false; // the first LLM call of a prompt already has a fresh judgment
  let lastEffort: string | undefined; // effort this extension set last; any other value means the user changed it
  let effortPaused = false;

  const setEffort = (effort: string) => {
    pi.setThinkingLevel(effort);
    lastEffort = pi.getThinkingLevel(); // omp clamps to the model's supported range
  };

  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.agent && ctx.agent.kind !== "main") return; // subagents keep their own model and effort
    const prompt = (event.prompt ?? "").trim();
    const current = ctx.models.current();
    if (!prompt || !current) return;
    task = prompt.slice(0, MAX_STATE_CHARS);
    // ponytail: approximates omp's matcher; does not skip code blocks.
    ultrathink = /(^|[^\w/\\.-])ultrathink(?![\w/\\(-]|\.\w)/.test(prompt);
    skipNextStep = true;
    // A level picked by hand (`/thinking`) stays for the rest of the session.
    if (lastEffort !== undefined && pi.getThinkingLevel() !== lastEffort) effortPaused = true;

    const models = new Map<string, Model>();
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
    const routeModel = models.size >= 2 && [...models.values()].some((m) => key(m) === key(current));

    const questions: Record<string, unknown> = {};
    if (routeModel) {
      questions.tier = {
        type: "choice",
        instructions: "Pick the cheapest model tier that can handle this coding-agent turn well.",
        criteria: Object.fromEntries([...models.keys()].map((t) => [t, TIERS[t]])),
      };
    }
    if (!effortPaused && !ultrathink) {
      questions.effort = { type: "choice", instructions: "Pick the reasoning effort this turn needs.", criteria: EFFORTS };
    }

    const notify = (msg: string, level: string) => ctx.hasUI && ctx.ui.notify(msg, level);
    try {
      const answers = Object.keys(questions).length ? await ask(ctx, { user_turn: task }, questions) : {};
      const notes: string[] = [];
      const target = models.get(answers.tier?.choice);
      if (target && key(target) !== key(current) && (await pi.setModel(target))) {
        notes.push(`${answers.tier.choice} → ${key(target)}`);
      }
      const effort = effortPaused ? undefined : ultrathink ? "max" : answers.effort?.choice;
      if (effort) {
        setEffort(effort);
        notes.push(`effort ${lastEffort}`);
      }
      if (notes.length) notify(`judge-router: ${notes.join(", ")}`, "info");
    } catch (err) {
      notify(`judge-router: routing skipped (${err instanceof Error ? err.message : err})`, "warning");
    }
  });

  // `context` runs before every LLM call of the tool loop, before omp reads the effort.
  pi.on("context", async (event, ctx) => {
    if (ctx.agent && ctx.agent.kind !== "main") return;
    if (skipNextStep || effortPaused || ultrathink || !task) {
      skipNextStep = false;
      return;
    }
    if (lastEffort !== undefined && pi.getThinkingLevel() !== lastEffort) {
      effortPaused = true;
      return;
    }
    try {
      const answers = await ask(
        ctx,
        { user_task: task, current_effort: lastEffort, recent_steps: recentSteps(event.messages) },
        {
          effort: {
            type: "choice",
            instructions:
              "A coding agent is working on the user task. Pick the reasoning effort its next step needs, given the recent steps.",
            criteria: EFFORTS,
          },
        },
      );
      const before = lastEffort;
      setEffort(answers.effort.choice);
      if (lastEffort !== before && ctx.hasUI) ctx.ui.notify(`judge-router: effort ${before} → ${lastEffort}`, "info");
    } catch {
      // ponytail: silent per-step failure; the step keeps the current effort
    }
  });
}
