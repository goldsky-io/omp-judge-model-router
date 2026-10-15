# omp-judge-model-router

An [omp](https://github.com/can1357/oh-my-pi) extension that picks the model and the thinking effort for each turn. It asks a judge model. A judge model (also called a decision model) answers typed questions, for example a choice between labels.

The extension can route at two intervals:

| Interval | When the judge runs | What it sees |
|---|---|---|
| `prompt` | Before each user prompt | The prompt |
| `step` | After each batch of tool results, before the next LLM request in the tool loop | The prompt, the current tier and effort, and the latest tool calls and results |

At each interval, the extension can route the model, the effort, both, or nothing. One judge request answers every question for that interval. The default is `prompt` = model and effort, and `step` = nothing. The [benchmark](#benchmark) shows why.

| Tier | Model | Used for |
|---|---|---|
| `smol` | `modelRoles.smol` | Lookups, renames, one-line edits, short answers |
| `default` | `modelRoles.default`, or the model the session started on | Ordinary coding work |
| `slow` | `modelRoles.slow` | Open-ended design, hard bugs, large refactors |

A tier that has no model is left out of the question. Model routing needs at least two tiers.

## Requirements

- omp with a credential for the provider of the judge model. The default judge, `openrouter/~typesafe/jev-latest`, needs only an OpenRouter key (`OPENROUTER_API_KEY` or `/login openrouter`).
- At least one of `modelRoles.smol` or `modelRoles.slow` in your omp configuration, for model routing.

## Install

```bash
omp plugin install github:goldsky-io/omp-judge-model-router
```

`omp plugin install` needs `bun` on your `PATH`. Restart omp after you install the plugin.

## Configuration

The configuration is in `~/.omp/agent/judge-model-router.json`. To use another file, set `JUDGE_ROUTER_CONFIG` to its path. Missing keys use the defaults.

```json
{
  "judge": "openrouter/~typesafe/jev-latest",
  "prompt": ["model", "effort"],
  "step": []
}
```

You can change the file with the `/judge-router` command in the omp TUI. The next prompt or step uses the change.

```text
/judge-router prompt model,effort
/judge-router step effort
/judge-router step none
```

### Judge model

The extension accepts any judge model in the omp catalog, from any provider that omp can reach. omp sends the request in the format of that provider: OpenRouter Decisions, TypeSafe System One, Cloudflare Workers AI, or OpenAI Decisions.

To pick from the judge models that you have credentials for, run `/judge-router` with no argument. To set the judge model directly, give a `provider/id` selector, for example `/judge-router openrouter/cloudflare/clef-flash`. To list the judge models in the catalog, run `omp models --kind=judge`. The `JUDGE_ROUTER_MODEL` environment variable overrides the judge in the file.

| Selector | Provider | Credential |
|---|---|---|
| `openrouter/~typesafe/jev-latest` | OpenRouter | `OPENROUTER_API_KEY` |
| `openrouter/cloudflare/clef-flash` | OpenRouter | `OPENROUTER_API_KEY` |
| `typesafe/jev-latest` | TypeSafe | `TYPESAFE_API_KEY` |
| `cloudflare-workers-ai/@cf/cloudflare/clef-flash` | Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` |
| `openai/gpt-6-luna-decisions` | OpenAI | `OPENAI_API_KEY` |

Some OpenRouter judge models are served only by providers that your OpenRouter account can block. If OpenRouter rejects the request, the turn runs on the current model and effort.

## Thinking effort

The judge picks the lowest of four levels that it expects to be enough.

| Level | Used for |
|---|---|
| `low` | Most coding work: reading, searching, commands, clear edits, standard implementations |
| `medium` | Tricky but well-specified logic, or a result that needs interpretation |
| `high` | A failure with no obvious cause, or a subtle correctness or concurrency problem |
| `xhigh` | Open-ended design across many parts, or a problem that still fails after several attempts |

omp lowers a level that the current model does not support to the nearest supported level. If the prompt contains the word `ultrathink`, the extension sets `max` and does not ask the judge about the effort.

When the extension sets an effort, omp turns off its built-in `auto` classifier for the session, so each prompt makes one judge request, not two. If no interval routes the effort, omp's own setting applies. If you set a level by hand with `/thinking`, the extension stops changing the effort for the rest of the session.

## Behavior

- The extension works only in the main session. Subagents keep their own models and efforts.
- If you pick a model outside the tiers with `/model`, model routing stops. It starts again when you pick a tier model.
- If the judge request fails or times out (8 seconds), the prompt or step runs on the current model and effort.
- In the TUI, each change shows a notice such as `judge-router (prompt): smol → zai/glm-5.3-flash, effort high → low`.
- Each judge request adds a `judge-router` entry to the session file with the answers and the cost.

If `modelRoles.default` uses an alias that the extension cannot resolve, the default tier is the first non-tier model the session ran on. A resumed session that ended on a tier model then routes only after you pick the default model again. Set `modelRoles.default` to an exact model id to avoid this.

## Cost of cache misses

A model switch costs more than the judge request. Each model has its own prompt cache. When a session moves to a model whose cache does not hold the conversation, that request writes the whole context to the cache. On Anthropic models, a cache write costs 1.25 times the input price and a cache read costs 0.1 times, so the switch costs about 12 times as much as a cached request for the same tokens. A switch inside the tool loop (`step` with `model`) can do this several times per prompt.

An effort change does not cause a cache miss with omp on Claude Opus 5.5. In a test that changed the effort between `low` and `high` before each of five tool steps, every request still read the cached prefix, and the cost was the same as with a fixed effort. Anthropic documents that a changed effort invalidates the message cache unless the change is sent as a per-message effort. omp appears to send it in that form. Other providers can behave differently.

Each judge request costs about $0.00002 with Jev and adds about one second before the LLM request.

## Benchmark

`bench/bench.py` runs the same tasks with omp alone and with several configurations of the extension, then prints a table. Each run is a fresh print-mode session in a temporary directory, with the advisor turned off. A run passes if its check command succeeds after the session ends.

```bash
python3 bench/bench.py --reps 2 --jobs 8
python3 bench/bench.py --configs omp-auto,prompt-both --tasks fix-bug,lru-ttl
```

The tasks are a two-question chat, a bug fix, a rename across files, a new function with tests, a subtle bug (a mutable default argument), and an LRU cache with expiry. Costs come from the session files: LLM usage, omp's built-in judge calls, and this extension's judge calls. The script appends raw rows to `bench-results.jsonl`.

Results from October 2026, with Claude Opus 5.5 as `default` and `zai/glm-5.3-flash` as `smol`, 6 tasks × 2 runs per configuration:

| Configuration | Passed | Cost $ | Judge calls | Median wall s |
|---|---|---|---|---|
| omp alone, `--thinking auto` | 12/12 | 0.784 | 0 | 12 |
| `prompt` = model, effort (default) | 12/12 | 0.517 | 16 | 13 |
| `prompt` = model, effort; `step` = effort | 12/12 | 0.518 | 40 | 13 |
| `prompt` = model, effort; `step` = model, effort | 12/12 | 0.487 | 42 | 16 |

The default cost 34% less than omp alone. Most of the saving came from prompts that never reached Opus: the chat and the rename cost about $0.002 each on glm-flash, against $0.04 to $0.06 on Opus. Routing the effort at each step added judge calls and saved nothing, because the judge kept `low` for these tasks. Routing the model at each step saved another 6% but took 25% longer and moved more of the work to the small model. These tasks are small, so the benchmark does not show how a small model does on long, hard work. Run it with your own tasks before you turn on `step` routing.

## Uninstall

```bash
omp plugin uninstall omp-judge-model-router
```
