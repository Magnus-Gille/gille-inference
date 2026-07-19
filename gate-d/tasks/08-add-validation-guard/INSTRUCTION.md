`test/account.oracle.ts` fails. Add validation to `withdraw` in `src/account.ts` so it THROWS
on a negative amount and on an overdraft (amount greater than the balance), *before* mutating
the account, while still working for valid withdrawals. Do not modify any file under `test/`.
