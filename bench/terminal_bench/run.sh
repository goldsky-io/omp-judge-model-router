#!/usr/bin/env bash
# Runs a Terminal-Bench 2.0 subset once per router configuration, all jobs in parallel.
# Usage: bench/terminal_bench/run.sh <creds.json> [jobs-dir]
# <creds.json> is an `omp auth export` file with every credential the run needs.
set -euo pipefail
creds=$1
jobs=${2:-./tb-jobs}
cd "$(dirname "$0")"
tasks=(
  headless-terminal regex-log chess-best-move count-dataset-tokens sqlite-db-truncate
  password-recovery git-multibranch filter-js-from-html log-summary-date-ranges largest-eigenval
  extract-elf sanitize-git-repo openssl-selfsigned-cert nginx-request-logging cancel-async-tasks
)
include=()
for t in "${tasks[@]}"; do include+=(-i "$t"); done
for router in none prompt-both prompt-both+step-effort prompt-both+step-both; do
  PYTHONPATH=. harbor run -d terminal-bench@2.0 "${include[@]}" \
    -a omp_acp_agent:OmpAcpAgent --ak "router=$router" --ak "creds=$creds" \
    -n "${CONCURRENCY:-2}" -k "${ATTEMPTS:-1}" -o "$jobs" --job-name "$router" >"$jobs-$router.log" 2>&1 &
done
wait
