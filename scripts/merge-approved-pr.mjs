import { githubApi } from './lib/github-api.mjs';
import { readyToMerge } from './lib/approved-merge.mjs';
const api = githubApi();
const pulls = await api('/pulls?state=open&base=main&per_page=100');
for (const summary of pulls) {
  const pull = await api(`/pulls/${summary.number}`);
  const reviews = await api(`/pulls/${pull.number}/reviews?per_page=100`);
  const trusted = new Set();
  for (const login of new Set(reviews.map(review => review.user.login))) {
    const access = await api(`/collaborators/${encodeURIComponent(login)}/permission`, { missing: true });
    if (access && ['admin', 'maintain', 'write'].includes(access.permission)) trusted.add(login);
  }
  const { check_runs: checks } = await api(`/commits/${pull.head.sha}/check-runs?per_page=100&filter=latest`);
  if (!readyToMerge(pull, reviews, checks, trusted)) { console.log(`PR #${pull.number}: waiting for approval, current CI or conflict resolution`); continue; }
  const merged = await api(`/pulls/${pull.number}/merge`, { method: 'PUT', body: { sha: pull.head.sha, merge_method: 'squash' } });
  if (!merged.merged) throw new Error(`GitHub refused merge of PR #${pull.number}`);
  // GITHUB_TOKEN pushes do not reliably start other workflows. Dispatch explicitly.
  await api('/actions/workflows/release.yml/dispatches', { method: 'POST', body: { ref: 'main' } });
  console.log(`Merged approved PR #${pull.number} at ${merged.sha}; dispatched the main release workflow`);
}
