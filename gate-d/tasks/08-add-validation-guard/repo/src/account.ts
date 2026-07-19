export interface Account {
  balance: number;
}

/**
 * Withdraw `amt` from `acc`, returning the new balance.
 * BUG: no validation — accepts negative amounts and allows overdraft (balance going below 0).
 * It must THROW on `amt < 0` and on `amt > acc.balance`, before mutating.
 */
export function withdraw(acc: Account, amt: number): number {
  acc.balance -= amt;
  return acc.balance;
}
