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
  {
    id: "atomic",
    prompt: "When a checkout fails because one item is out of stock, the stock already reserved for the other items of the order is not released. Fix it so a failed checkout leaves every stock level unchanged.",
    // Hidden test written after the run, so the agent cannot fit the check.
    check: "cat > hidden.test.ts <<'TS'\nimport { expect, test } from \"bun:test\"\nimport { addProduct, clearCatalog, findProduct } from \"./src/inventory\"\nimport { checkout } from \"./src/checkout\"\ntest(\"a failed checkout leaves stock unchanged\", () => {\n  clearCatalog()\n  addProduct({ sku: \"a\", name: \"A\", price: 1, stock: 5 })\n  addProduct({ sku: \"b\", name: \"B\", price: 1, stock: 1 })\n  const user = { id: \"u\", email: \"u@x.io\", loyaltyPoints: 0 }\n  const result = checkout(user, [{ product: findProduct(\"a\")!, quantity: 2 }, { product: findProduct(\"b\")!, quantity: 3 }])\n  expect(result.ok).toBe(false)\n  expect(findProduct(\"a\")!.stock).toBe(5)\n  expect(findProduct(\"b\")!.stock).toBe(1)\n})\nTS\nbun test hidden.test.ts && git diff --quiet -- test",
  },
  {
    id: "tax",
    prompt: "Products get an optional `category` field: \"food\" or \"standard\". Food is taxed at 5.5%; every other product, including products without a category, at the checkout tax rate. Update the code so checkout totals use the right rate per item.",
    // Hidden test written after the run, so the agent cannot fit the check.
    check: "cat > hidden.test.ts <<'TS'\nimport { expect, test } from \"bun:test\"\nimport { addProduct, clearCatalog, findProduct } from \"./src/inventory\"\nimport { checkout } from \"./src/checkout\"\ntest(\"food is taxed at 5.5%, the rest at the checkout rate\", () => {\n  clearCatalog()\n  addProduct({ sku: \"bread\", name: \"Bread\", price: 10, stock: 5, category: \"food\" })\n  addProduct({ sku: \"pen\", name: \"Pen\", price: 10, stock: 5 })\n  const user = { id: \"u\", email: \"u@x.io\", loyaltyPoints: 0 }\n  const result = checkout(user, [{ product: findProduct(\"bread\")!, quantity: 1 }, { product: findProduct(\"pen\")!, quantity: 1 }])\n  expect(result).toEqual({ ok: true, total: 22.55 })\n})\ntest(\"products without a category keep the checkout rate\", () => {\n  clearCatalog()\n  addProduct({ sku: \"pen\", name: \"Pen\", price: 10, stock: 5 })\n  const user = { id: \"u\", email: \"u@x.io\", loyaltyPoints: 0 }\n  expect(checkout(user, [{ product: findProduct(\"pen\")!, quantity: 2 }])).toEqual({ ok: true, total: 24 })\n})\nTS\nbun test hidden.test.ts",
  },
  {
    id: "email",
    prompt: "checkout must reject a user whose email is invalid, returning { ok: false, reason: \"invalid email\" }, without reserving any stock.",
    // Hidden test written after the run, so the agent cannot fit the check.
    check: "cat > hidden.test.ts <<'TS'\nimport { expect, test } from \"bun:test\"\nimport { addProduct, clearCatalog, findProduct } from \"./src/inventory\"\nimport { checkout } from \"./src/checkout\"\ntest(\"an invalid email is rejected before any stock is reserved\", () => {\n  clearCatalog()\n  addProduct({ sku: \"a\", name: \"A\", price: 1, stock: 5 })\n  const result = checkout({ id: \"u\", email: \"not-an-email\", loyaltyPoints: 0 }, [{ product: findProduct(\"a\")!, quantity: 2 }])\n  expect(result).toEqual({ ok: false, reason: \"invalid email\" })\n  expect(findProduct(\"a\")!.stock).toBe(5)\n})\nTS\nbun test hidden.test.ts",
  },
  {
    id: "restock",
    prompt: "Add removeProduct(sku) and restock(sku, quantity) to the inventory module. restock throws on an unknown sku or a quantity that is not positive. Cover both with tests.",
    // Hidden test written after the run, so the agent cannot fit the check.
    check: "cat > hidden.test.ts <<'TS'\nimport { expect, test } from \"bun:test\"\nimport { addProduct, clearCatalog, findProduct, removeProduct, restock } from \"./src/inventory\"\ntest(\"restock and removeProduct\", () => {\n  clearCatalog()\n  addProduct({ sku: \"a\", name: \"A\", price: 1, stock: 1 })\n  restock(\"a\", 4)\n  expect(findProduct(\"a\")!.stock).toBe(5)\n  expect(() => restock(\"a\", 0)).toThrow()\n  expect(() => restock(\"a\", -2)).toThrow()\n  expect(() => restock(\"zzz\", 1)).toThrow()\n  removeProduct(\"a\")\n  expect(findProduct(\"a\")).toBeUndefined()\n})\nTS\nbun test hidden.test.ts && test -n \"$(git status --porcelain -- test)\"",
  },
]
