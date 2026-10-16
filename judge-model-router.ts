// Picks the model and the thinking effort for the main session with a judge
// (decision) model. Any judge model in omp's catalog works: OpenRouter Decisions,
// TypeSafe, Cloudflare Workers AI, or OpenAI Decisions.
//
// Two intervals, each configurable to route the model, the effort, both, or nothing:
// - prompt: before each user prompt (`before_agent_start`).
// - step: after each batch of tool results, before the next LLM call of the tool
//   loop (`tool_result` is awaited before omp builds the next request).
// One judge request per interval answers every question for that interval.
// Setting an explicit effort turns off omp's built-in `auto` classifier for the session.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createNativeJudge, isJudgmentApi } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-ai";

type Target = "model" | "effort";
interface Config {
  judge: string;
  prompt: Target[];
  step: Target[];
}

const DEFAULT_CONFIG: Config = { judge: "openrouter/~typesafe/jev-latest", prompt: ["model", "effort"], step: [] };
// ponytail: fixed to the default profile's agent dir; named profiles share this file.
const CONFIG_FILE = process.env.JUDGE_ROUTER_CONFIG || path.join(os.homedir(), ".omp", "agent", "judge-model-router.json");
// These providers serve only judge models, so they are missing from getAll().
const JUDGE_ONLY_PROVIDERS = ["typesafe", "cloudflare-workers-ai"];
const MAX_STATE_CHARS = 8000; // ponytail: tail-only truncation; Jev context is ~32k tokens
const TIERS: Record<string, string> = {
  smol: "Trivial or mechanical work: a lookup, a rename, a one-line edit, a short factual answer, or casual chat.",
  default: "Ordinary coding work: implement or change a feature, fix a clear bug, write tests or docs.",
  slow: "Hard work: open-ended design, a subtle bug with no clear cause, a large refactor, or deep multi-step reasoning.",
};
// `max` is reserved for the `ultrathink` keyword, as in omp's built-in classifier.
// Biased low: in benchmarks, tasks passed at `low` and higher levels only added cost.
// Short replies inherit the difficulty of the work they approve; the level tracks the
// work the turn implies, not the length of the message.
const EFFORTS: Record<string, string> = {
  low: "Work whose next step is already fully specified and local: reading, searching, running commands, a clear edit, a mechanical change, or approving or continuing such work.",
  medium: "Well-specified work with real constraints to get right: changes that must hold across many call sites, ordering, rate or size limits, or a small design choice among given options.",
  high: "Subtle correctness: intermittent failures, races, timing or time-zone assumptions, state that must stay consistent, or a fix that has already failed at least once.",
  xhigh: "Open-ended design across many parts, or a problem that still fails after several attempts.",
};

const key = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

function loadConfig(): Config {
  let saved: Partial<Config> = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {}
  const config = { ...DEFAULT_CONFIG, ...saved };
  if (process.env.JUDGE_ROUTER_MODEL) config.judge = process.env.JUDGE_ROUTER_MODEL;
  return config;
}

function saveConfig(patch: Partial<Config>): Config {
  let saved: Partial<Config> = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {}
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify({ ...saved, ...patch }, null, 2)}\n`);
  return loadConfig();
}

/** `provider/id` → catalog judge model, or undefined when the selector names no judge model. */
function findJudge(registry, selector: string): Model | undefined {
  const slash = selector.indexOf("/");
  const model = slash > 0 ? registry.find(selector.slice(0, slash), selector.slice(slash + 1)) : undefined;
  return model && isJudgmentApi(model.api) ? model : undefined;
}

/** Parses `model,effort`, `effort`, or `none` into a target list; undefined when invalid. */
function parseTargets(text: string): Target[] | undefined {
  if (text === "none") return [];
  const targets = text.split(",").map((t) => t.trim());
  return targets.every((t) => t === "model" || t === "effort") ? (targets as Target[]) : undefined;
}

const MAX_CONTEXT_CHARS = 2000;
// ponytail: reads only the cwd file; omp also merges AGENTS.md files from parent dirs.
const MAX_AGENTS_CHARS = 12000; // keeps the whole state under Jev's ~32k-byte fast mode

/** The project's AGENTS.md (or CLAUDE.md) in `cwd`, head-truncated. */
function projectInstructions(cwd: string): Record<string, string> {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      return { project_agents_md: fs.readFileSync(path.join(cwd, name), "utf8").slice(0, MAX_AGENTS_CHARS) };
    } catch {}
  }
  return {};
}

/** The exchange before the new prompt, so a reply such as "yes" routes on the work it approves. */
function previousExchange(ctx): Record<string, string> {
  const text = (m) =>
    typeof m.content === "string" ? m.content : (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
  let assistant = "";
  for (const e of ctx.sessionManager.getBranch().toReversed()) {
    if (e.type !== "message" || (e.message.role !== "user" && e.message.role !== "assistant")) continue;
    if (e.message.role === "assistant") {
      assistant ||= text(e.message);
      continue;
    }
    // An interrupted turn (user message with no reply) yields no exchange rather than a stale one.
    if (!assistant) return {};
    return {
      previous_user_turn: text(e.message).slice(0, MAX_CONTEXT_CHARS),
      previous_assistant_reply: assistant.slice(-MAX_CONTEXT_CHARS),
    };
  }
  return {};
}

export default function (pi) {
  pi.registerCommand("judge-router", {
    description: "Set the judge model, or what to route per prompt and per step: /judge-router [judge | prompt <targets> | step <targets>]",
    handler: async (args, ctx) => {
      const registry = ctx.modelRegistry;
      const [first = "", rest = ""] = args.trim().split(/\s+/, 2);
      if (first === "prompt" || first === "step") {
        const targets = parseTargets(rest);
        if (!targets) {
          ctx.ui.notify("judge-router: targets are model, effort, model,effort, or none", "error");
          return;
        }
        const config = saveConfig({ [first]: targets });
        ctx.ui.notify(`judge-router: prompt=${config.prompt.join(",") || "none"} step=${config.step.join(",") || "none"}`, "info");
        return;
      }
      let selector = first;
      if (!selector) {
        const options: string[] = [];
        for (const provider of new Set([...registry.getAll().map((m) => m.provider), ...JUDGE_ONLY_PROVIDERS])) {
          const judges = (registry.getProviderModels(provider) ?? []).filter((m) => isJudgmentApi(m.api));
          if (judges.length && (await registry.getApiKey(judges[0]))) options.push(...judges.map(key));
        }
        selector = (await ctx.ui.select(`Judge model (current: ${loadConfig().judge})`, options)) ?? "";
        if (!selector) return;
      }
      if (!findJudge(registry, selector)) {
        ctx.ui.notify(`judge-router: ${selector} is not a judge model`, "error");
        return;
      }
      saveConfig({ judge: selector });
      const shadowed = process.env.JUDGE_ROUTER_MODEL ? " (JUDGE_ROUTER_MODEL still overrides it)" : "";
      ctx.ui.notify(`judge-router: judge model set to ${selector}${shadowed}`, "info");
    },
  });

  let home: Model | undefined; // fallback "default" tier: the first non-tier model this session ran on
  let task = ""; // the latest user prompt
  let steps: string[] = []; // assistant text, tool calls, and tool results since that prompt
  let pendingTools = 0; // tool results still due for the latest assistant message
  let ultrathink = false;
  let context: Record<string, string> = {}; // project AGENTS.md and the exchange before the latest prompt
  let lastEffort: string | undefined; // effort after this extension's last change; anything else is a manual change
  let effortPaused = false;

  /** Asks the judge for every target of this interval and applies the answers. */
  async function route(ctx, interval: "prompt" | "step", targets: Target[]) {
    const notify = (msg: string, level: string) => ctx.hasUI && ctx.ui.notify(msg, level);
    const current = ctx.models.current();
    if (!current) return;
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

    const questions: Record<string, unknown> = {};
    // A model picked by hand (outside the tiers) stays until you pick a tier model again.
    if (targets.includes("model") && models.size >= 2 && [...models.values()].some((m) => key(m) === key(current))) {
      questions.tier = {
        type: "choice",
        instructions:
          interval === "prompt"
            ? "Pick the cheapest model tier that can handle this coding-agent turn well."
            : "A coding agent is working on the user task. Pick the cheapest model tier that can do its next step well, given the recent steps.",
        criteria: Object.fromEntries([...models.keys()].map((t) => [t, TIERS[t]])),
      };
    }
    const routeEffort = targets.includes("effort") && !effortPaused;
    if (routeEffort && !ultrathink) {
      questions.effort = {
        type: "choice",
        instructions:
          interval === "prompt"
            ? "Pick the lowest reasoning effort that can still do this coding-agent turn correctly."
            : "A coding agent is working on the user task. Pick the lowest reasoning effort that can still do its next step correctly, given the recent steps.",
        criteria: EFFORTS,
      };
    }
    if (!Object.keys(questions).length && !(routeEffort && ultrathink && interval === "prompt")) return;

    const config = loadConfig();
    try {
      let answers: Record<string, { choice: string }> = {};
      if (Object.keys(questions).length) {
        const judge = findJudge(ctx.modelRegistry, config.judge);
        if (!judge) throw new Error(`${config.judge} is not a judge model`);
        const apiKey = await ctx.modelRegistry.getApiKey(judge);
        if (!apiKey) throw new Error(`no ${judge.provider} credential for ${config.judge}`);
        // Jev runs a slower, less accurate long-context mode past ~32k bytes (OpenRouter Jev guide).
        // Give recent_steps whatever byte budget the other fields leave.
        const contextChars = JSON.stringify(context).length;
        const stepsBudget = Math.max(0, 30_000 - task.length - contextChars - 200);
        const state =
          interval === "prompt"
            ? { user_turn: task, ...context }
            : {
                user_task: task,
                ...context,
                current_tier: [...models].find(([, m]) => key(m) === key(current))?.[0],
                current_effort: pi.getThinkingLevel(),
                recent_steps: stepsBudget ? steps.join("\n").slice(-stepsBudget) : "",
              };
        const result = await createNativeJudge(judge, { apiKey }).judge(
          { state, questions },
          { signal: AbortSignal.timeout(8000) },
        );
        answers = result.answers;
        pi.appendEntry("judge-router", { interval, judge: config.judge, answers, cost: result.usage?.cost?.total });
      }

      const notes: string[] = [];
      const target = models.get(answers.tier?.choice);
      if (target && key(target) !== key(current) && (await pi.setModel(target))) {
        notes.push(`${answers.tier.choice} → ${key(target)}`);
      }
      const effort = !routeEffort ? undefined : ultrathink ? "max" : answers.effort?.choice;
      const before = pi.getThinkingLevel();
      if (effort) pi.setThinkingLevel(effort);
      lastEffort = pi.getThinkingLevel(); // omp clamps to the model's range and may re-apply it on a model switch
      if (lastEffort !== before) notes.push(`effort ${before} → ${lastEffort}`);
      if (notes.length) notify(`judge-router (${interval}): ${notes.join(", ")}`, "info");
    } catch (err) {
      notify(`judge-router: ${interval} routing skipped (${err instanceof Error ? err.message : err})`, "warning");
    }
  }

  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.agent && ctx.agent.kind !== "main") return; // subagents keep their own model and effort
    const prompt = (event.prompt ?? "").trim();
    if (!prompt) return;
    task = prompt.slice(0, MAX_STATE_CHARS);
    steps = [];
    pendingTools = 0;
    context = { ...projectInstructions(ctx.cwd), ...previousExchange(ctx) };
    // ponytail: approximates omp's matcher; does not skip code blocks.
    ultrathink = /(^|[^\w/\\.-])ultrathink(?![\w/\\(-]|\.\w)/.test(prompt);
    await route(ctx, "prompt", loadConfig().prompt);
  });

  pi.on("assistant_message", (event, ctx) => {
    if (ctx.agent && ctx.agent.kind !== "main") return;
    pendingTools = 0;
    for (const p of event.message.content ?? []) {
      if (p.type === "text") steps.push(`assistant: ${p.text.slice(0, 1500)}`);
      if (p.type === "toolCall") {
        pendingTools++;
        steps.push(`tool call ${p.name}: ${JSON.stringify(p.arguments).slice(0, 300)}`);
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (ctx.agent && ctx.agent.kind !== "main") return;
    const text = event.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
    steps.push(`tool result${event.isError ? " (error)" : ""}: ${text.slice(0, 1500)}`);
    // Route once per batch, after its last result; omp awaits this before the next LLM call.
    // A result with no counted call (omp replaying unpaired tool calls on retry) routes at once.
    if (pendingTools > 0 && --pendingTools > 0) return;
    const targets = loadConfig().step;
    if (targets.length) await route(ctx, "step", targets);
  });
}
