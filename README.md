# omp-judge-model-router

An [omp](https://github.com/can1357/oh-my-pi) extension that picks the model and the thinking effort for each turn. It asks a judge model. A judge model (also called a decision model) answers typed questions, for example a choice between labels.

Before each user prompt, one judge request chooses a model tier and an effort level. The extension switches the session model to that tier and sets the effort before the request goes out. During the tool loop, the extension asks the judge again before each later LLM request. That request chooses only the effort, from the latest tool calls and results. The model stays the same until the next prompt.

| Tier | Model | Used for |
|---|---|---|
| `smol` | `modelRoles.smol` | Lookups, renames, one-line edits, short answers |
| `default` | `modelRoles.default`, or the model the session started on | Ordinary coding work |
| `slow` | `modelRoles.slow` | Open-ended design, hard bugs, large refactors |

A tier that has no model is left out of the question. The extension needs at least two tiers.

## Requirements

- omp with a credential for the provider of the judge model. The default judge, `openrouter/~typesafe/jev-latest`, needs only an OpenRouter key (`OPENROUTER_API_KEY` or `/login openrouter`).
- At least one of `modelRoles.smol` or `modelRoles.slow` in your omp configuration.

## Install

```bash
omp plugin install github:goldsky-io/omp-judge-model-router
```

`omp plugin install` needs `bun` on your `PATH`. Restart omp after you install the plugin.

## Choose the judge model

The extension accepts any judge model in the omp catalog, from any provider that omp can reach. omp sends the request in the format of that provider: OpenRouter Decisions, TypeSafe System One, Cloudflare Workers AI, or OpenAI Decisions.

To pick from the judge models that you have credentials for, run this command in the omp TUI:

```text
/judge-router
```

To set the judge model directly, give a `provider/id` selector:

```text
/judge-router openrouter/cloudflare/clef-flash
```

The command writes the choice to `~/.omp/agent/judge-model-router.json`, and the next turn uses it. To list the judge models in the catalog, run `omp models --kind=judge`.

The judge model is selected in this order:

1. The `JUDGE_ROUTER_MODEL` environment variable, for example `JUDGE_ROUTER_MODEL=typesafe/jev-latest`.
2. The model saved by `/judge-router`.
3. `openrouter/~typesafe/jev-latest`.

| Selector | Provider | Credential |
|---|---|---|
| `openrouter/~typesafe/jev-latest` | OpenRouter | `OPENROUTER_API_KEY` |
| `openrouter/cloudflare/clef-flash` | OpenRouter | `OPENROUTER_API_KEY` |
| `typesafe/jev-latest` | TypeSafe | `TYPESAFE_API_KEY` |
| `cloudflare-workers-ai/@cf/cloudflare/clef-flash` | Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` |
| `openai/gpt-6-luna-decisions` | OpenAI | `OPENAI_API_KEY` |

Some OpenRouter judge models are served only by providers that your OpenRouter account can block. If OpenRouter rejects the request, the turn runs on the current model.

## Thinking effort

The judge chooses one of four levels for each prompt and for each later step of the tool loop.

| Level | Used for |
|---|---|
| `low` | Reading, searching, running a command, or an obvious edit |
| `medium` | A small change that must fit existing code, or an unclear result |
| `high` | A non-obvious fix, a failing test or error to diagnose |
| `xhigh` | Design, subtle or repeated failures, concurrency, security |

omp lowers a level that the current model does not support to the nearest supported level. If the prompt contains the word `ultrathink`, the extension sets `max` and does not ask the judge about the effort.

The extension sets an explicit level, which turns off omp's built-in `auto` classifier for the session. Each prompt therefore makes one judge request, not two. If you set a level by hand with `/thinking`, the extension stops changing the effort for the rest of the session. Model routing continues.

## Behavior

- The extension works only in the main session. Subagents keep their own models and efforts.
- If you pick a model outside the tiers with `/model`, model routing stops. It starts again when you pick a tier model. The effort is still chosen for each prompt and step.
- If the judge request fails or times out (8 seconds), the prompt or step runs on the current model and effort.
- In the TUI, each change shows a notice such as `judge-router: smol → zai/glm-5.3-flash, effort low` or `judge-router: effort low → high`.
- Each judge request costs about $0.00002 with Jev and adds about one second before the LLM request. A prompt with ten tool steps makes about ten judge requests.
- Each model switch discards the provider prompt cache, so the next request pays for the full context again. On Anthropic models, an effort change can also invalidate the cached message prefix.

If `modelRoles.default` uses an alias that the extension cannot resolve, the default tier is the first non-tier model the session ran on. A resumed session that ended on a tier model then routes only after you pick the default model again. Set `modelRoles.default` to an exact model id to avoid this.

## Uninstall

```bash
omp plugin uninstall omp-judge-model-router
```
