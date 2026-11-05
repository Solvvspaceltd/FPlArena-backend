/**
 * Standard competition ranking.
 *
 * Two managers level on points share a position, and the next one down takes
 * the place after both of them: 1, 2, 2, 4. Ranking by array index instead
 * gave one of them second and the other third, decided by whatever order the
 * database happened to return - which is to say, by nothing.
 *
 * The rows must already be sorted, best first. This only assigns the numbers;
 * it does not decide the order.
 */
export function withRank<T>(sorted: T[], valueOf: (row: T) => number): (T & { rank: number })[] {
  let rank = 0;
  let last: number | null = null;

  return sorted.map((row, i) => {
    const v = valueOf(row);
    if (last === null || v !== last) {
      rank = i + 1;
      last = v;
    }
    return { ...row, rank };
  });
}

/** True when anybody in the sorted list shares a position with anybody else. */
export function hasTies<T>(sorted: T[], valueOf: (row: T) => number): boolean {
  for (let i = 1; i < sorted.length; i++) {
    if (valueOf(sorted[i]) === valueOf(sorted[i - 1])) return true;
  }
  return false;
}
