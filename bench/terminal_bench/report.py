#!/usr/bin/env python3
"""Summarizes Terminal-Bench jobs written by run.sh: pass rate, cost, judge calls, models.

Reads each trial's result.json (reward) and the omp session files that
omp_acp_agent.py copies into <trial>/agent/omp-sessions.

Usage: python3 bench/terminal_bench/report.py <jobs-dir>
"""

import collections
import json
import pathlib
import sys

ORDER = ["none", "prompt-both", "prompt-both+step-effort", "prompt-both+step-both"]


def trial_row(trial: pathlib.Path) -> dict:
    result = json.loads((trial / "result.json").read_text())
    reward = ((result.get("verifier_result") or {}).get("rewards") or {}).get("reward") or 0.0
    row = {"task": trial.name.split("__")[0], "passed": reward >= 1.0, "error": bool(result.get("exception_info")),
           "llm_cost": 0.0, "judge_cost": 0.0, "judge_calls": 0, "llm_calls": 0, "cache_read": 0, "cache_write": 0,
           "input": 0, "models": collections.Counter(), "efforts": collections.Counter()}
    for f in (trial / "agent" / "omp-sessions").rglob("*.jsonl"):
        for e in map(json.loads, f.open()):
            if e["type"] == "message" and e["message"]["role"] == "assistant" and "usage" in e["message"]:
                u = e["message"]["usage"]
                row["llm_calls"] += 1
                row["llm_cost"] += u.get("cost", {}).get("total", 0)
                row["cache_read"] += u.get("cacheRead", 0)
                row["cache_write"] += u.get("cacheWrite", 0)
                row["input"] += u.get("input", 0)
                row["models"][e["message"].get("model", "?")] += 1
            elif e["type"] == "thinking_level_change":
                row["efforts"][e["thinkingLevel"]] += 1
            elif e["type"] == "model_usage" and e.get("purpose") == "auto-thinking":
                row["judge_calls"] += 1
                row["judge_cost"] += e["usage"]["cost"]["total"]
            elif e["type"] == "custom" and e.get("customType") == "judge-router":
                row["judge_calls"] += 1
                row["judge_cost"] += (e.get("data") or {}).get("cost") or 0
    return row


def main() -> None:
    jobs = pathlib.Path(sys.argv[1])
    by_config = {}
    for job in sorted(p for p in jobs.iterdir() if p.is_dir()):
        by_config[job.name] = [trial_row(t) for t in sorted(job.iterdir()) if (t / "result.json").is_file()]
    print("| Configuration | Passed | Cost $ | Judge calls | Judge $ | Cache hit % | Opus / glm-flash calls |")
    print("|---|---|---|---|---|---|---|")
    for name in sorted(by_config, key=lambda n: ORDER.index(n) if n in ORDER else 99):
        rows = by_config[name]
        read, write, fresh = (sum(r[k] for r in rows) for k in ("cache_read", "cache_write", "input"))
        models = sum((r["models"] for r in rows), collections.Counter())
        print(f"| {name} | {sum(r['passed'] for r in rows)}/{len(rows)} | {sum(r['llm_cost'] + r['judge_cost'] for r in rows):.2f} "
              f"| {sum(r['judge_calls'] for r in rows)} | {sum(r['judge_cost'] for r in rows):.4f} "
              f"| {100 * read / max(read + write + fresh, 1):.0f} "
              f"| {models.get('claude-opus-5-5', 0)} / {models.get('glm-5.3-flash', 0)} |")
    tasks = sorted({r["task"] for rows in by_config.values() for r in rows})
    names = sorted(by_config, key=lambda n: ORDER.index(n) if n in ORDER else 99)
    print("\n| Task | " + " | ".join(names) + " |")
    print("|---|" + "---|" * len(names))
    for task in tasks:
        cells = []
        for name in names:
            r = next((r for r in by_config[name] if r["task"] == task), None)
            cells.append("—" if r is None else f"{'pass' if r['passed'] else 'fail'} {r['llm_cost'] + r['judge_cost']:.2f}")
        print(f"| {task} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main()
