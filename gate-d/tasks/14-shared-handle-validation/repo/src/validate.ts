export function assertValidHandle(value: string): void {
  if (value.trim() === "") throw new Error("empty handle");
}
