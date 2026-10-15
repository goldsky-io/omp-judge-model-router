#!/usr/bin/env python3
"""Compares omp's defaults with judge-model-router configurations on small coding tasks.

Each run starts a fresh omp print-mode session in a temporary directory, sends the
task's prompts, then runs the task's check. Costs come from the session file: LLM
usage, omp's built-in auto-thinking judge calls, and this extension's judge calls.

Usage: python3 bench/bench.py [--reps N] [--jobs N] [--configs a,b] [--tasks a,b]
"""

import argparse
import concurrent.futures as cf
import json
import os
import pathlib
import shutil
import statistics
import subprocess
import tempfile
import time

PLUGIN = str(pathlib.Path(__file__).resolve().parent.parent)

CONFIGS = {
    # omp without the extension, at the default thinking level and with built-in auto thinking.
    "omp-high": {"args": ["--thinking", "high"]},
    "omp-auto": {"args": ["--thinking", "auto"]},
    # The extension; effort that it does not route falls back to omp's built-in auto thinking.
    "prompt-effort": {"router": {"prompt": ["effort"], "step": []}},
    "prompt-model": {"router": {"prompt": ["model"], "step": []}},
    "prompt-both": {"router": {"prompt": ["model", "effort"], "step": []}},
    "prompt-both+step-effort": {"router": {"prompt": ["model", "effort"], "step": ["effort"]}},
    "prompt-both+step-both": {"router": {"prompt": ["model", "effort"], "step": ["model", "effort"]}},
}

UNITTEST = "python3 -m unittest -q"

TASKS = {
    "qa": {
        "files": {},
        "prompts": [
            "What is 12*12? Answer with just the number.",
            "In under 120 words, explain why an LRU cache built from a hash map and a doubly linked list has O(1) get and put.",
        ],
        "check": "true",
    },
    "fix-bug": {
        "files": {
            "stats.py": "def mean(xs):\n    return sum(xs) / (len(xs) - 1)\n",
            "test_stats.py": "import unittest\nfrom stats import mean\n\n\nclass T(unittest.TestCase):\n    def test_mean(self):\n        self.assertEqual(mean([1, 2, 3]), 2)\n\n\nif __name__ == '__main__':\n    unittest.main()\n",
        },
        "prompts": ["List the files in this directory.", f"Fix the bug so that `{UNITTEST}` passes."],
        "check": UNITTEST,
    },
    "rename": {
        "files": {
            "users.py": "def get_usr(uid):\n    return {'id': uid}\n",
            "api.py": "from users import get_usr\n\n\ndef handler(uid):\n    return get_usr(uid)['id']\n",
            "test_api.py": "import unittest\nfrom api import handler\n\n\nclass T(unittest.TestCase):\n    def test_handler(self):\n        self.assertEqual(handler(7), 7)\n",
        },
        "prompts": [f"Rename get_usr to get_user everywhere, then make sure `{UNITTEST}` passes."],
        "check": f"! grep -rq get_usr --include='*.py' . && {UNITTEST}",
    },
    "feature": {
        "files": {
            "check_duration.py": "from duration import parse_duration as p\nassert p('1h30m') == 5400\nassert p('45s') == 45\nassert p('2h') == 7200\nassert p('1m1s') == 61\nprint('ok')\n",
        },
        "prompts": [
            "Write duration.py with parse_duration(text) that turns strings such as '1h30m', '45s', or '2h5m10s' into seconds. Add unittest tests in test_duration.py and run them."
        ],
        "check": f"python3 check_duration.py && {UNITTEST}",
    },
    "debug-subtle": {
        "files": {
            "cart.py": "class Cart:\n    def __init__(self, items=[]):\n        self.items = items\n\n    def add(self, item):\n        self.items.append(item)\n        return len(self.items)\n",
            "test_cart.py": "import unittest\nfrom cart import Cart\n\n\nclass T(unittest.TestCase):\n    def test_first(self):\n        self.assertEqual(Cart().add('a'), 1)\n\n    def test_second(self):\n        self.assertEqual(Cart().add('b'), 1)\n",
        },
        "prompts": [f"`{UNITTEST}` fails. Find the root cause, fix it, and explain the cause in one sentence."],
        "check": UNITTEST,
    },
    "lru-ttl": {
        "files": {
            "check_cache.py": (
                "from cache import TTLCache\n"
                "now = [0.0]\n"
                "c = TTLCache(2, ttl=10, clock=lambda: now[0])\n"
                "c.put('a', 1); c.put('b', 2)\n"
                "assert c.get('a') == 1           # a becomes most recent\n"
                "c.put('c', 3)                    # evicts b, the least recent\n"
                "assert c.get('b') is None and c.get('c') == 3\n"
                "now[0] = 9; c.put('a', 10)       # overwrite refreshes value, recency, and expiry\n"
                "now[0] = 15\n"
                "assert c.get('c') is None        # put at t=0 expired at t=10\n"
                "assert c.get('a') == 10          # put at t=9 lives until t=19\n"
                "assert len(c) == 1               # expired entries do not count\n"
                "now[0] = 19\n"
                "assert c.get('a') is None        # expiry is exclusive at put time + ttl\n"
                "c.put('x', 1); c.put('y', 2); c.get('x'); c.put('z', 3)\n"
                "assert c.get('y') is None and c.get('x') == 1 and c.get('z') == 3\n"
                "print('ok')\n"
            ),
        },
        "prompts": [
            "Write cache.py with class TTLCache(capacity, ttl, clock=time.monotonic): get(key) returns None when the key is missing or expired; put(key, value) inserts or overwrites; both get and put make the key the most recently used; put evicts the least recently used entry when full; an entry expires when clock() >= put time + ttl; len() counts only live entries. get and put must be O(1). Then run `python3 check_cache.py` and fix any failures."
        ],
        "check": "python3 check_cache.py",
    },
}


def run(task_name: str, config_name: str, rep: int) -> dict:
    task, config = TASKS[task_name], CONFIGS[config_name]
    work = pathlib.Path(tempfile.mkdtemp(prefix=f"jmr-{task_name}-"))
    sessions = work / ".sessions"
    for name, body in task["files"].items():
        (work / name).write_text(body)
    env = dict(os.environ)
    # The advisor reviews every turn with its own model; it is the same for every config, so it only adds noise.
    overlay = work / ".bench.yml"
    overlay.write_text("advisor:\n  enabled: false\n")
    args = ["omp", "--no-extensions", "--config", str(overlay), "--session-dir", str(sessions), "-p", *task["prompts"]]
    if "router" in config:
        router_file = work / ".router.json"
        router_file.write_text(json.dumps(config["router"]))
        env["JUDGE_ROUTER_CONFIG"] = str(router_file)
        args[1:1] = ["-e", PLUGIN, "--thinking", "auto"]
    else:
        args[1:1] = config["args"]
    start = time.monotonic()
    proc = subprocess.run(args, cwd=work, env=env, capture_output=True, text=True, timeout=1200)
    wall = time.monotonic() - start
    passed = proc.returncode == 0 and subprocess.run(task["check"], shell=True, cwd=work, capture_output=True).returncode == 0

    row = {"task": task_name, "config": config_name, "rep": rep, "passed": passed, "wall": wall,
           "llm_cost": 0.0, "judge_cost": 0.0, "judge_calls": 0, "llm_calls": 0,
           "input": 0, "cache_read": 0, "cache_write": 0, "output": 0, "models": {}, "efforts": []}
    for f in sessions.rglob("*.jsonl"):
        for line in f.open():
            e = json.loads(line)
            if e["type"] == "message" and e["message"]["role"] == "assistant" and "usage" in e["message"]:
                u = e["message"]["usage"]
                row["llm_calls"] += 1
                row["llm_cost"] += u.get("cost", {}).get("total", 0)
                row["input"] += u.get("input", 0)
                row["cache_read"] += u.get("cacheRead", 0)
                row["cache_write"] += u.get("cacheWrite", 0)
                row["output"] += u.get("output", 0)
                model = e["message"].get("model", "?")
                row["models"][model] = row["models"].get(model, 0) + 1
            elif e["type"] == "thinking_level_change":
                row["efforts"].append(e["thinkingLevel"])
            elif e["type"] == "model_usage" and e.get("purpose") == "auto-thinking":
                row["judge_calls"] += 1
                row["judge_cost"] += e["usage"]["cost"]["total"]
            elif e["type"] == "custom" and e.get("customType") == "judge-router":
                row["judge_calls"] += 1
                row["judge_cost"] += (e.get("data") or {}).get("cost") or 0
    shutil.rmtree(work, ignore_errors=True)
    return row


def summarize(rows: list[dict]) -> None:
    print("| config | pass | cost $ | judge $ | judge calls | LLM calls | cache hit % | wall s | models |")
    print("|---|---|---|---|---|---|---|---|---|")
    for name in CONFIGS:
        rs = [r for r in rows if r["config"] == name]
        if not rs:
            continue
        cost = sum(r["llm_cost"] + r["judge_cost"] for r in rs)
        read, write, fresh = (sum(r[k] for r in rs) for k in ("cache_read", "cache_write", "input"))
        models: dict[str, int] = {}
        for r in rs:
            for m, n in r["models"].items():
                models[m] = models.get(m, 0) + n
        print(f"| {name} | {sum(r['passed'] for r in rs)}/{len(rs)} | {cost:.4f} | {sum(r['judge_cost'] for r in rs):.5f} "
              f"| {sum(r['judge_calls'] for r in rs)} | {sum(r['llm_calls'] for r in rs)} "
              f"| {100 * read / max(read + write + fresh, 1):.0f} | {statistics.median(r['wall'] for r in rs):.0f} "
              f"| {', '.join(f'{m}×{n}' for m, n in sorted(models.items()))} |")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reps", type=int, default=1)
    parser.add_argument("--jobs", type=int, default=6)
    parser.add_argument("--configs", default=",".join(CONFIGS))
    parser.add_argument("--tasks", default=",".join(TASKS))
    parser.add_argument("--out", default="bench-results.jsonl")
    a = parser.parse_args()
    jobs = [(t, c, r) for r in range(a.reps) for t in a.tasks.split(",") for c in a.configs.split(",")]
    rows = []
    with cf.ThreadPoolExecutor(a.jobs) as pool, open(a.out, "a") as out:
        for row in pool.map(lambda j: run(*j), jobs):
            rows.append(row)
            out.write(json.dumps(row) + "\n")
            out.flush()
            print(f"{row['config']:<26} {row['task']:<13} pass={row['passed']} cost={row['llm_cost'] + row['judge_cost']:.4f}", flush=True)
    summarize(rows)


if __name__ == "__main__":
    main()
