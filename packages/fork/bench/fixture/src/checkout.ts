import { calcTotal, type LineItem } from "./cart"
import { reserve } from "./inventory"
import { loyaltyDiscount, type User } from "./user"

const TAX_RATE = 0.2

export function checkout(user: User, items: LineItem[]) {
  const reserved = items.every((item) => reserve(item.product.sku, item.quantity))
  if (!reserved) return { ok: false as const, reason: "out of stock" }
  return { ok: true as const, total: calcTotal(items, loyaltyDiscount(user), TAX_RATE) }
}
