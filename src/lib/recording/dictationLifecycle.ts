let finish: (() => Promise<unknown>) | null = null;
export function registerDictationFinisher(next: () => Promise<unknown>): void {
  finish = next;
}
export async function finishDictationBeforeNavigation(): Promise<void> {
  await finish?.();
}
