export interface Account {
  balance: number;
}

/** Withdraw `amt` from `acc`; throw on negative amount or overdraft. (REFERENCE SOLUTION.) */
export function withdraw(acc: Account, amt: number): number {
  if (amt < 0) throw new Error(`negative amount: ${amt}`);
  if (amt > acc.balance) throw new Error(`overdraft: ${amt} > ${acc.balance}`);
  acc.balance -= amt;
  return acc.balance;
}
