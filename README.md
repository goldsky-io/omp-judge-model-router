# omp-judge-model-router

An [omp](https://github.com/can1357/oh-my-pi) extension that picks the model and the thinking effort for each turn. It asks a judge model. A judge model (also called a decision model) answers typed questions, for example a choice between labels.

The extension can route at two intervals:

| Interval | When the judge runs | What it sees |
|---|---|---|
| `prompt` | Before each user prompt | The prompt |
| `step` | After each batch of tool results, before the next LLM request in the tool loop | The prompt, the current tier and effort, and the latest tool calls and results |

At each interval, the extension can route the model, the effort, both, or nothing. One judge request answers every question for that interval. The default is `prompt` = model and effort, and `step` = nothing. The [benchmarks](#benchmarks) show why.

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

## Benchmarks

Three benchmarks measure the extension. The local benchmark runs short tasks with omp in print mode. Terminal-Bench 2.0 runs real terminal tasks with omp over ACP (Agent Client Protocol). The TwinRouterBench static track scores only the judge's tier choices, without running an agent.

| Benchmark | What it measures | Default config result |
|---|---|---|
| Local tasks | Cost and pass rate on 6 short coding tasks | 34% cheaper than omp `auto`, 12/12 passed |
| Terminal-Bench 2.0 subset | Cost and pass rate on 15 terminal tasks | 42% cheaper than omp `auto`, 13/15 passed (omp `auto`: 12/15) |
| TwinRouterBench static | Tier choice on 970 agent steps | Combined score 72.7, against 54.4 for always-Opus and 63.6 for always-small |

The default stays at `prompt` = model and effort, with no `step` routing. No benchmark showed a gain from `step` routing that justifies its extra judge calls and its risk.

### Local tasks

`bench/bench.py` runs the same tasks with omp alone and with several configurations of the extension, then prints a table. Each run is a fresh print-mode session in a temporary directory, with the advisor turned off. A run passes if its check command succeeds after the session ends.

```bash
python3 bench/bench.py --reps 2 --jobs 8
python3 bench/bench.py --configs omp-auto,prompt-both --tasks fix-bug,lru-ttl
```

The tasks are a two-question chat, a bug fix, a rename across files, a new function with tests, a subtle bug (a mutable default argument), and an LRU cache with expiry. Costs come from the session files: LLM usage, omp's built-in judge calls, and this extension's judge calls. The script appends raw rows to `bench-results.jsonl`.

#### Results

Run on October 15, 2026, with omp 18.10.4, Claude Opus 5.5 as `default`, `zai/glm-5.3-flash` as `smol`, no `slow` role, and `openrouter/~typesafe/jev-latest` as the judge. Each configuration ran 6 tasks 2 times. Every run passed its check.

| Configuration | Passed | Cost $ | vs omp auto | Judge calls | Judge $ | Median wall s | Opus / glm-flash calls |
|---|---|---|---|---|---|---|---|
| omp alone, `--thinking high` | 12/12 | 1.067 | +33% | 0 | 0 | 14 | 50 / 0 |
| omp alone, `--thinking auto` | 12/12 | 0.805 | | 0 | 0 | 12 | 41 / 0 |
| `prompt` = effort | 12/12 | 0.750 | −7% | 16 | 0.0003 | 13 | 41 / 0 |
| `prompt` = model | 12/12 | 0.571 | −29% | 16 | 0.0003 | 13 | 26 / 15 |
| `prompt` = model, effort (default) | 12/12 | 0.534 | −34% | 16 | 0.0004 | 15 | 25 / 18 |
| `prompt` = model, effort; `step` = effort | 12/12 | 0.521 | −35% | 43 | 0.0016 | 14 | 24 / 19 |
| `prompt` = model, effort; `step` = model, effort | 12/12 | 0.443 | −45% | 44 | 0.0017 | 13 | 18 / 26 |

Mean cost per run in dollars, by task:

| Task | omp high | omp auto | prompt: effort | prompt: model | prompt: both | + step: effort | + step: both |
|---|---|---|---|---|---|---|---|
| qa | 0.040 | 0.039 | 0.040 | 0.001 | 0.001 | 0.001 | 0.001 |
| rename | 0.092 | 0.062 | 0.063 | 0.002 | 0.002 | 0.003 | 0.003 |
| fix-bug | 0.070 | 0.066 | 0.066 | 0.059 | 0.060 | 0.058 | 0.037 |
| feature | 0.112 | 0.061 | 0.064 | 0.062 | 0.063 | 0.061 | 0.062 |
| debug-subtle | 0.087 | 0.093 | 0.059 | 0.094 | 0.059 | 0.059 | 0.050 |
| lru-ttl | 0.132 | 0.081 | 0.083 | 0.068 | 0.082 | 0.078 | 0.069 |

What the results show:

- Model routing per prompt gives most of the saving. Prompts that the judge sent to glm-flash never reached Opus: the chat and the rename cost about $0.002 each, against $0.04 to $0.09 on Opus.
- Effort routing alone saves little, because omp's `auto` already picks `low` for most of these tasks. The `high` default costs 33% more than `auto` and passed no more tasks.
- Effort routing at each step saved 2% and made 2.7 times as many judge calls. The judge kept `low` at every step of these tasks.
- Model routing at each step saved the most. In an earlier run with the same code but an older wording of the effort question, it saved 6% over the default and took 25% longer. The size of this saving changes between runs.
- The judge requests cost less than 0.4% of the total in every configuration.

These six tasks are short, and a small model finishes all of them. They do not show what happens when the small model takes over steps of a long, hard task, where a failed step costs more than the saving.

### Terminal-Bench 2.0

[Terminal-Bench 2.0](https://www.tbench.ai) has 89 tasks that an agent does in a Docker container, each checked by tests. [Harbor](https://github.com/harbor-framework/harbor) runs them. `bench/terminal_bench/omp_acp_agent.py` is a Harbor agent built on Harbor's ACP adapter. It copies the omp binary, an omp configuration, the extension, and credentials into each task container, then runs `omp acp` there. Harbor approves every tool permission request. After each trial, the agent copies omp's session files into the trial logs.

You need Docker, Harbor (`uv tool install harbor`), and a credentials file. Make the credentials file with `omp auth export`. Keep only the credentials that the run needs (here anthropic, zai, and openrouter). Replace each OAuth `refresh` value with a placeholder string, so that a container cannot rotate the refresh token of your host. Without a refresh token, a run must finish before the access token expires.

```bash
bench/terminal_bench/run.sh /path/to/creds.json /tmp/tb/jobs
python3 bench/terminal_bench/report.py /tmp/tb/jobs
```

`run.sh` runs 15 tasks once for each of four configurations, all at the same time, two trials at a time per configuration. The tasks are short ones with small images: `headless-terminal`, `regex-log`, `chess-best-move`, `count-dataset-tokens`, `sqlite-db-truncate`, `password-recovery`, `git-multibranch`, `filter-js-from-html`, `log-summary-date-ranges`, `largest-eigenval`, `extract-elf`, `sanitize-git-repo`, `openssl-selfsigned-cert`, `nginx-request-logging`, and `cancel-async-tasks`.

#### Results

Run on October 16, 2026, with the same models and judge as the local tasks, Harbor 0.24.0, and 1 attempt per task. "omp auto" is omp without the extension, with `defaultThinkingLevel: auto`. Each configuration took 13 to 15 minutes.

| Configuration | Passed | Cost $ | vs omp auto | Judge calls | Judge $ | Cache hit % | Opus / glm-flash calls |
|---|---|---|---|---|---|---|---|
| omp auto | 12/15 | 1.74 | | 15 | 0.0004 | 92 | 65 / 0 |
| `prompt` = model, effort (default) | 13/15 | 1.01 | −42% | 15 | 0.0005 | 95 | 62 / 0 |
| `prompt` = model, effort; `step` = effort | 13/15 | 1.04 | −40% | 64 | 0.0031 | 95 | 63 / 0 |
| `prompt` = model, effort; `step` = model, effort | 12/15 | 1.04 | −40% | 61 | 0.0032 | 93 | 58 / 2 |

Cost in dollars and result by task:

| Task | omp auto | prompt: both | + step: effort | + step: both |
|---|---|---|---|---|
| cancel-async-tasks | pass 0.31 | pass 0.10 | pass 0.12 | pass 0.17 |
| chess-best-move | fail 0.05 | pass 0.10 | pass 0.07 | fail 0.04 |
| count-dataset-tokens | pass 0.05 | pass 0.08 | pass 0.05 | pass 0.07 |
| extract-elf | pass 0.17 | pass 0.06 | pass 0.06 | pass 0.07 |
| filter-js-from-html | fail 0.01 | fail 0.13 | fail 0.13 | fail 0.11 |
| git-multibranch | pass 0.07 | pass 0.06 | pass 0.11 | pass 0.13 |
| headless-terminal | pass 0.20 | pass 0.08 | pass 0.06 | pass 0.07 |
| largest-eigenval | pass 0.52 | pass 0.05 | pass 0.07 | pass 0.06 |
| log-summary-date-ranges | pass 0.05 | pass 0.05 | pass 0.06 | pass 0.04 |
| nginx-request-logging | pass 0.04 | pass 0.05 | pass 0.05 | pass 0.05 |
| openssl-selfsigned-cert | pass 0.07 | pass 0.07 | pass 0.07 | pass 0.05 |
| password-recovery | fail 0.00 | fail 0.00 | fail 0.00 | fail 0.00 |
| regex-log | pass 0.05 | pass 0.05 | pass 0.06 | pass 0.05 |
| sanitize-git-repo | pass 0.06 | pass 0.06 | pass 0.06 | pass 0.06 |
| sqlite-db-truncate | pass 0.10 | pass 0.06 | pass 0.06 | pass 0.07 |

What the results show:

- The judge sent every Terminal-Bench prompt to Opus. Each task is real work, so prompt-level model routing had no effect here.
- The saving came from the effort. omp's built-in classifier chose `xhigh` for `largest-eigenval` and `cancel-async-tasks`, and the judge chose `medium`. Those two tasks cost $0.83 under omp auto and $0.15 with the extension, and both passed.
- Step routing added 46 to 49 judge calls and saved nothing. With `step` = model and effort, the judge sent 2 steps to glm-flash, and `chess-best-move` failed after one of them.
- Anthropic refused `password-recovery` in every configuration and `filter-js-from-html` under omp auto, with the message `Refusal (cyber): This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.` These failures do not come from routing.
- With one attempt per task, a difference of one passed task is within run-to-run variation.

### TwinRouterBench static track

[TwinRouterBench](https://github.com/CommonstackAI/TwinRouterBench) (arXiv 2605.18859) has 970 states taken from the middle of agent runs on SWE-bench, BFCL, mtRAG, QMSum, and PinchBench. Each state has a label: the cheapest of four tiers (low, mid, mid_high, high) that was confirmed to finish the task. A choice passes if its tier is at least the label. The benchmark reports four scores:

- Case pass rate: the share of steps where the choice passes.
- Trajectory pass rate: the share of steps in runs where every choice passes.
- Cost savings: the saving against always using the high tier, with a penalty for each failed run.
- Combined score: one number that weighs pass rate against cost savings.

`bench/twinrouter/eval_judge.py` sends each state to the judge as one step decision, in the shape the extension uses: the user task, the latest steps, and one `choice` question. It runs two variants. `plugin` uses the extension's two tiers today, `smol` and `default`, mapped to low and high. `4tier` asks for the four TwinRouterBench tiers. The script writes the scores to `bench/twinrouter/twinrouter-<variant>.json`.

```bash
git clone https://github.com/CommonstackAI/TwinRouterBench
cd TwinRouterBench && uv venv && uv pip install -e . && cd -
TwinRouterBench/.venv/bin/python bench/twinrouter/eval_judge.py --repo TwinRouterBench
```

#### Results

Run on October 16, 2026, on all 970 states, with `openrouter/~typesafe/jev-latest` as the judge. The three fixed choices are baselines that the TwinRouterBench scorer computes without a judge.

| Router | Case pass % | Trajectory pass % | Cost savings % | Combined % | Judge $ |
|---|---|---|---|---|---|
| Always high | 100.0 | 100.0 | 0.0 | 54.4 | 0 |
| Always mid_high | 82.5 | 65.6 | 54.7 | 51.9 | 0 |
| Always low | 71.0 | 58.5 | 54.1 | 63.6 | 0 |
| Judge, `plugin` (smol or default) | 94.5 | 85.2 | 39.8 | 72.7 | 0.08 |
| Judge, `4tier` | 76.2 | 61.0 | 55.1 | 60.3 | 0.09 |

What the results show:

- With the extension's two tiers, the judge scored higher than every fixed choice. It kept 94.5% of steps safe and saved 39.8% against always using the high tier.
- On SWE-bench steps alone, its cost savings score was −16.5%. The judge sent too many hard SWE-bench steps to the small tier, and each failed run counts as a full rerun on the high tier. This matches the Terminal-Bench result: step-level model routing is risky on long coding tasks.
- With four tiers, the judge never chose the high tier and scored below always-low. The tier descriptions in this variant need work before the extension supports four tiers.

TwinRouterBench also has a dynamic track that runs a router on 100 SWE-bench Verified tasks with its own agent and model pool (DeepSeek, MiniMax, Gemini Flash, and Claude Opus 4.6). It does not run omp or this extension, and the published runs cost $25 to $55 each, so it is not part of this benchmark.

## Uninstall

```bash
omp plugin uninstall omp-judge-model-router
```
