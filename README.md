# omp-jev-router

An [omp](https://github.com/can1357/oh-my-pi) extension that picks a model for each user turn. Before each turn, it sends your prompt to an OpenRouter decision model (`~typesafe/jev-latest` by default). The decision model chooses one of three tiers, and the extension switches the session model to that tier before the request goes out.

| Tier | Model | Used for |
|---|---|---|
| `smol` | `modelRoles.smol` | Lookups, renames, one-line edits, short answers |
| `default` | `modelRoles.default`, or the model the session started on | Ordinary coding work |
| `slow` | `modelRoles.slow` | Open-ended design, hard bugs, large refactors |

A tier that has no model is left out of the question. The extension needs at least two tiers.

## Requirements

- omp with an OpenRouter credential. Set `OPENROUTER_API_KEY`, or run `/login openrouter`. You do not need a TypeSafe account.
- At least one of `modelRoles.smol` or `modelRoles.slow` in your omp configuration.

## Install

```bash
omp plugin install github:goldsky-io/omp-jev-router
```

Restart omp after you install the plugin.

## Thinking effort

The extension changes only the model. To also adjust the thinking effort for each turn, turn on omp's built-in automatic thinking. It uses the same decision model.

```bash
omp config set defaultThinkingLevel auto
```

The model switch keeps the `auto` setting.

## Behavior

- The extension routes only the main session. Subagents keep their own models.
- If you pick a model outside the tiers with `/model`, routing stops. Routing starts again when you pick a tier model.
- If the decision request fails or times out (8 seconds), the turn runs on the current model.
- In the TUI, each switch shows a notice such as `jev-router: smol → zai/glm-5.3-flash (99%)`.
- Each request costs about $0.00002. Each model switch discards the provider prompt cache, so the next request pays for the full context again.

If `modelRoles.default` uses an alias that the extension cannot resolve, the default tier is the first non-tier model the session ran on. A resumed session that ended on a tier model then routes only after you pick the default model again. Set `modelRoles.default` to an exact model id to avoid this.

## Configuration

| Environment variable | Default | Effect |
|---|---|---|
| `JEV_ROUTER_MODEL` | `~typesafe/jev-latest` | OpenRouter decision model, for example `cloudflare/clef-flash` |

## Uninstall

```bash
omp plugin uninstall omp-jev-router
```
