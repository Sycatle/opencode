// Frozen tasks replayed on the fixture repo. Each check runs in the task's
// working copy and must exit 0 for the task to count as a success.
export const tasks = [
  {
    id: "explore",
    prompt:
      "Without modifying any file under src/ or test/, write ARCHITECTURE.md listing every module in src/ with one sentence describing what it does.",
    check: "test -f ARCHITECTURE.md && for m in cart inventory format user checkout; do grep -q $m ARCHITECTURE.md || exit 1; done && git diff --quiet -- src test",
  },
  {
    id: "debug",
    prompt: "The test suite fails. Find and fix the bug in the source code. Do not modify the tests.",
    check: "bun test && git diff --quiet -- test",
  },
  {
    id: "refactor",
    prompt: "Rename the function calcTotal to computeTotal everywhere in the project, including tests.",
    check: "! grep -rq calcTotal src test && grep -q computeTotal src/cart.ts && grep -q computeTotal src/checkout.ts",
  },
  {
    id: "feature",
    prompt:
      "Add src/coupon.ts exporting applyCoupon(code: string, total: number): number. SAVE10 removes 10% of the total, FLAT5 removes 5 (never below 0), unknown codes leave the total unchanged. Add tests in test/coupon.test.ts.",
    check:
      "test -f test/coupon.test.ts && bun test test/coupon.test.ts && printf 'import { applyCoupon } from \"./src/coupon\"\\nif (applyCoupon(\"SAVE10\", 50) !== 45 || applyCoupon(\"FLAT5\", 3) !== 0 || applyCoupon(\"NOPE\", 7) !== 7) process.exit(1)\\n' > verify.ts && bun verify.ts",
  },
  {
    id: "survey",
    prompt:
      "Read every file in src/ and test/, then write NOTES.md with one '## <path>' heading per file followed by a short summary of that file.",
    check: "test $(grep -c '^## ' NOTES.md) -ge 7",
  },
]
