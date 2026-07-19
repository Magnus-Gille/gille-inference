export function assertValidHandle(value: string): void {
  if (!/^[a-z0-9_-]{1,20}$/i.test(value)) throw new Error("invalid handle");
}
