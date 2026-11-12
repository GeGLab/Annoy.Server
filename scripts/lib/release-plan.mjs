export function parseReleaseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta)\.(\d+))?$/.exec(value);
  if (!match) throw new Error(`Unsupported main-line release version: ${value}`);
  return { core: match.slice(1, 4).map(Number), channel: match[4] ?? null, number: Number(match[5] ?? 0) };
}
export function compareVersions(a, b) {
  const x = parseReleaseVersion(a), y = parseReleaseVersion(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  const rank = { alpha: 0, beta: 1, null: 2 };
  return rank[x.channel] - rank[y.channel] || x.number - y.number;
}
export function planRelease(sourceVersion, releases, sha) {
  parseReleaseVersion(sourceVersion);
  const known = releases.filter(release => !release.prerelease && /^v\d+\.\d+\.\d+(?:-(?:alpha|beta)\.\d+)?$/.test(release.tag_name));
  const same = known.find(release => release.commit === sha && !release.draft) ?? known.find(release => release.commit === sha);
  if (same) return { version: same.tag_name.slice(1), publish: same.draft, resume: true };
  const latest = known.filter(release => !release.draft).map(release => release.tag_name.slice(1)).sort(compareVersions).at(-1);
  let version = sourceVersion;
  if (latest && compareVersions(sourceVersion, latest) <= 0) {
    const value = parseReleaseVersion(latest);
    version = value.channel ? `${value.core.join('.')}-${value.channel}.${value.number + 1}` : `${value.core[0]}.${value.core[1]}.${value.core[2] + 1}`;
  }
  while (known.some(release => release.tag_name === `v${version}`)) {
    const value = parseReleaseVersion(version);
    version = value.channel ? `${value.core.join('.')}-${value.channel}.${value.number + 1}` : `${value.core[0]}.${value.core[1]}.${value.core[2] + 1}`;
  }
  return { version, publish: true, resume: false };
}
export function requireMergedPullRequest(pulls, sha) {
  const pull = pulls.find(item => item.merged_at && item.base?.ref === 'main' && item.merge_commit_sha === sha);
  if (!pull) throw new Error('Release refused: this commit is not the result of a PR merged into main');
  return pull;
}
