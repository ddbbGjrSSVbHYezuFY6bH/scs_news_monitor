export function parseLookbackHours(value = 24) {
  if (value === '24') value = 24;
  if (value === '72') value = 72;
  if (value !== 24 && value !== 72) throw new Error('lookbackHours must be 24 or 72.');
  return value;
}

export function withSearchWindow(query, hours) {
  const lookbackHours = parseLookbackHours(hours);
  // Replace existing operators while preserving literal text inside quoted phrases.
  const search = query.replace(/"(?:\\.|[^"\\])*"|(?<![\w:.-])when:[^\s()]+/gi,
    token => token.startsWith('"') ? token : '').trim();
  if (!search) throw new Error('Query must contain search terms besides its time window.');
  return `(${search}) when:${lookbackHours / 24}d`;
}
