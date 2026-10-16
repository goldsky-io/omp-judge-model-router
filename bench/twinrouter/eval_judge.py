#!/usr/bin/env python3
"""Scores the router's judge on the TwinRouterBench static track (970 agent-step prefixes).

Each prefix is sent to the judge as one step-interval decision, in the same shape the
extension uses: the user task plus the latest steps, and one `choice` question. The
TwinRouterBench scorer then compares the chosen tier with the cheapest tier that was
confirmed to finish the task (`pred >= gold` passes).

Two variants:
  plugin   the extension's two tiers today, smol and default, mapped to TwinRouterBench
           low (0) and high (3)
  4tier    four tiers that match TwinRouterBench low, mid, mid_high, high

Usage: python3 bench/twinrouter/eval_judge.py --repo /path/to/TwinRouterBench [--n 200]
Needs OPENROUTER_API_KEY. Writes twinrouter-<variant>.json next to this script.
"""

import argparse
import concurrent.futures as cf
import json
import os
import pathlib
import sys
import urllib.request

URL = "https://openrouter.ai/api/alpha/decisions"
MAX_STATE_CHARS = 8000
# Copied from judge-model-router.ts; keep in sync.
TIERS = {
    "smol": "Trivial or mechanical work: a lookup, a rename, a one-line edit, a short factual answer, or casual chat.",
    "default": "Ordinary coding work: implement or change a feature, fix a clear bug, write tests or docs.",
    "slow": "Hard work: open-ended design, a subtle bug with no clear cause, a large refactor, or deep multi-step reasoning.",
}
STEP_INSTRUCTIONS = (
    "A coding agent is working on the user task. Pick the cheapest model tier that can do its next step well, "
    "given the recent steps."
)
VARIANTS = {
    "plugin": ({"smol": TIERS["smol"], "default": TIERS["default"]}, {"smol": 0, "default": 3}),
    "4tier": (
        {
            "low": "A small, cheap model: trivial or mechanical steps, lookups, formatting, short answers.",
            "mid": "A mid-size model: routine tool use and clear, well-specified edits.",
            "mid_high": "A strong fast model: multi-step reasoning, non-obvious fixes, careful reading of results.",
            "high": "A frontier model: hard debugging, subtle correctness problems, open-ended design.",
        },
        {"low": 0, "mid": 1, "mid_high": 2, "high": 3},
    ),
}


def content_text(content) -> str:
    if isinstance(content, str):
        return content
    return "\n".join(p.get("text", "") for p in content or [] if isinstance(p, dict))


def state_for(row: dict) -> dict:
    messages = row["messages"]
    first = next((i for i, m in enumerate(messages) if m["role"] == "user"), 0)
    steps = []
    for m in messages[first + 1 :]:
        text = content_text(m.get("content"))
        if text:
            steps.append(f"{m['role']}: {text[:1500]}")
        for call in m.get("tool_calls") or []:
            fn = call.get("function", {})
            steps.append(f"tool call {fn.get('name')}: {str(fn.get('arguments'))[:300]}")
    task = content_text(messages[first]["content"]) if messages else ""
    return {"user_task": task[:MAX_STATE_CHARS], "recent_steps": "\n".join(steps)[-MAX_STATE_CHARS:]}


def judge(model: str, criteria: dict, state: dict) -> tuple[str, float]:
    body = {"model": model, "state": state, "questions": {"tier": {"type": "choice", "instructions": STEP_INSTRUCTIONS, "criteria": criteria}}}
    req = urllib.request.Request(URL, json.dumps(body).encode(), {
        "Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}", "Content-Type": "application/json"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                payload = json.load(res)
            return payload["answers"]["tier"]["choice"], payload["usage"].get("cost") or 0.0
        except Exception:
            if attempt == 3:
                raise
    raise AssertionError("unreachable")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True)
    p.add_argument("--variant", choices=[*VARIANTS, "all"], default="all")
    p.add_argument("--model", default="~typesafe/jev-latest")
    p.add_argument("--n", type=int, default=None, help="proportional sample size; default is all 970 rows")
    p.add_argument("--jobs", type=int, default=16)
    a = p.parse_args()
    sys.path.insert(0, a.repo)
    from main.eval import FunctionPredictor, run_question_bank_eval

    for variant in VARIANTS if a.variant == "all" else [a.variant]:
        criteria, to_tier = VARIANTS[variant]
        rows = [json.loads(line) for line in open(pathlib.Path(a.repo) / "data/static/question_bank.jsonl")]
        cost = 0.0
        # Judge every row up front in parallel; the scorer then reads the cached answers.
        with cf.ThreadPoolExecutor(a.jobs) as pool:
            answers = dict(zip((r["id"] for r in rows), pool.map(lambda r: judge(a.model, criteria, state_for(r)), rows)))
        cost = sum(c for _, c in answers.values())
        summary = run_question_bank_eval(
            FunctionPredictor(lambda row: to_tier[answers[row["id"]][0]]),
            predictor_label=f"{a.model} ({variant})",
            n=a.n,
            extra_summary={"judge_cost_usd": cost},
        )
        out = pathlib.Path(__file__).with_name(f"twinrouter-{variant}.json")
        compact = {k: summary[k] for k in ("classifier", "judge_cost_usd", "scores_v2", "router_accounting") if k in summary}
        out.write_text(json.dumps(compact, indent=2))
        v = summary["scores_v2"]
        print(variant, {k: round(v[k], 1) for k in ("case_pass_rate_percent", "trajectory_pass_rate_percent", "cost_savings_score_percent", "combined_score_percent")})


if __name__ == "__main__":
    main()
