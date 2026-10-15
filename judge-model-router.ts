// Routes each main-session user turn to one of three tiers: @smol, @default, or
// @slow (when those roles resolve). A judge (decision) model picks the tier. Any
// judge model in omp's catalog works: OpenRouter Decisions, TypeSafe, Cloudflare
// Workers AI, or OpenAI Decisions. Thinking effort stays with omp's built-in
// `defaultThinkingLevel: auto`, which pi.setModel preserves.

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
const MAX_PROMPT_CHARS = 8000; // ponytail: head-only truncation; Jev context is ~32k tokens
const TIERS: Record<string, string> = {
  smol: "Trivial or mechanical turn: a lookup, a rename, a one-line edit, a short factual answer, or casual chat.",
  default: "Ordinary coding turn: implement or change a feature, fix a clear bug, write tests or docs.",
  slow: "Hard turn: open-ended design, a subtle bug with no clear cause, a large refactor, or deep multi-step reasoning.",
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
  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.agent && ctx.agent.kind !== "main") return; // subagents keep their own model
    const prompt = (event.prompt ?? "").trim();
    const current = ctx.models.current();
    if (!prompt || !current) return;

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
    if (models.size < 2 || ![...models.values()].some((m) => key(m) === key(current))) return;

    const notify = (msg: string, level: string) => ctx.hasUI && ctx.ui.notify(msg, level);
    try {
      const selector = judgeSelector();
      const judgeModel = findJudge(ctx.modelRegistry, selector);
      if (!judgeModel) return notify(`judge-router: ${selector} is not a judge model; routing skipped`, "warning");
      const apiKey = await ctx.modelRegistry.getApiKey(judgeModel);
      if (!apiKey) return notify(`judge-router: no ${judgeModel.provider} credential; routing skipped`, "warning");
      const result = await createNativeJudge(judgeModel, { apiKey }).judge(
        {
          state: { user_turn: prompt.slice(0, MAX_PROMPT_CHARS) },
          questions: {
            tier: {
              type: "choice",
              instructions: "Pick the cheapest model tier that can handle this coding-agent turn well.",
              criteria: Object.fromEntries([...models.keys()].map((t) => [t, TIERS[t]])),
            },
          },
        },
        { signal: AbortSignal.timeout(8000) },
      );
      const answer = result.answers.tier;
      const target = models.get(answer.choice);
      if (!target || key(target) === key(current)) return;
      if (await pi.setModel(target)) {
        const confidence = Math.round((answer.confidence ?? 1) * 100);
        notify(`judge-router: ${answer.choice} → ${key(target)} (${confidence}%, ${key(judgeModel)})`, "info");
      }
    } catch (err) {
      notify(`judge-router: routing skipped (${err instanceof Error ? err.message : err})`, "warning");
    }
  });
}
