export function githubApi({ repository = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN, request = fetch } = {}) {
  if (!repository || !token) throw new Error('GitHub repository and token are required');
  return async (path, { method = 'GET', body, missing = false } = {}) => {
    const response = await request(`https://api.github.com/repos/${repository}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body && { 'content-type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
}
export async function requireMergedMain(api, sha) {
  if (!/^[a-f\d]{40}$/.test(sha ?? '')) throw new Error('A full source commit SHA is required');
  const comparison = await api(`/compare/${sha}...main`);
  if (!['ahead', 'identical'].includes(comparison.status) || comparison.base_commit?.sha !== sha) throw new Error('Release refused: source is not part of main');
  const { requireMergedPullRequest } = await import('./release-plan.mjs');
  return requireMergedPullRequest(await api(`/commits/${sha}/pulls?per_page=100`), sha);
}
