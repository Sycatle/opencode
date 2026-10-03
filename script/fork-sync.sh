#!/usr/bin/env bash
# Merge upstream dev into the fork, then verify. Stops on the first failure;
# on merge conflict, resolve (see docs/fork/seams.md) and rerun with --no-merge.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" != "--no-merge" ]]; then
  git fetch upstream dev
  git merge --no-edit upstream/dev
fi

bun install
grep -rn "FORK-SEAM" packages/ --include=*.ts
(cd packages/fork && bun run typecheck && bun run test)
(cd packages/opencode && bun run typecheck)
echo "Sync OK. Run the bench before shipping: (cd packages/fork && bun run bench --model <provider/model>)"
