export async function pool<T, R>(items: T[], size: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor;

      cursor += 1;

      if (index >= items.length) return;

      results[index] = await task(items[index]);
    }
  };

  const width = Math.max(1, Math.min(size, items.length || 1));

  await Promise.all(Array.from({ length: width }, () => worker()));

  return results;
}
