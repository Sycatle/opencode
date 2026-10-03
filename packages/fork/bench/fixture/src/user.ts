export type User = { id: string; email: string; loyaltyPoints: number }

export function loyaltyDiscount(user: User) {
  if (user.loyaltyPoints >= 1000) return 0.15
  if (user.loyaltyPoints >= 500) return 0.1
  if (user.loyaltyPoints >= 100) return 0.05
  return 0
}

export function isValidEmail(email: string) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
}
