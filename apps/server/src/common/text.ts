/**
 * Small string helpers that run in linear time. CodeQL flags regexes like
 * `/^-+|-+$/` and `/\/+$/` as slow on long hostile input, so the trimming is
 * done with plain loops instead.
 */

/** Remove every leading and trailing `ch` (a single character). */
export function trimChar(s: string, ch: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === ch) start++;
  while (end > start && s[end - 1] === ch) end--;
  return s.slice(start, end);
}

/** Remove every trailing `ch` (a single character). */
export function trimEndChar(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return s.slice(0, end);
}
