import { readFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { githubApi, requireMergedMain } from './lib/github-api.mjs';
import { planRelease } from './lib/release-plan.mjs';

const api = githubApi(), sha = process.env.GITHUB_SHA;
await requireMergedMain(api, sha);
const releases = await api('/releases?per_page=100');
for (const tag of execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).trim().split('\n')) {
  if (/^v\d+\.\d+\.\d+(?:-(?:alpha|beta)\.\d+)?$/.test(tag) && !releases.some(release => release.tag_name === tag)) releases.push({ tag_name: tag, draft: true, prerelease: false });
}
for (const release of releases) {
  try { release.commit = execFileSync('git', ['rev-parse', `${release.tag_name}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { release.commit = /^[a-f\d]{40}$/.test(release.target_commitish) ? release.target_commitish : null; }
}
const source = JSON.parse(await readFile('package.json', 'utf8'));
const plan = planRelease(source.version, releases, sha);
await appendFile(process.env.GITHUB_OUTPUT, `version=${plan.version}\npublish=${plan.publish}\n`);
console.log(`Merged main ${sha}: ${plan.publish ? 'prepare' : 'already published'} v${plan.version}`);
