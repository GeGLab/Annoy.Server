export const requiredChecks = ['validation (ubuntu-latest)', 'validation (windows-latest)'];
export function readyToMerge(pull, reviews, checks, trustedUsers) {
  if (pull.state !== 'open' || pull.draft || pull.base?.ref !== 'main' || pull.mergeable !== true || pull.mergeable_state === 'behind') return false;
  const latest = new Map();
  for (const review of reviews) if (trustedUsers.has(review.user.login) && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.user.login, review);
  if ([...latest.values()].some(review => review.state === 'CHANGES_REQUESTED')) return false;
  if (![...latest.values()].some(review => review.state === 'APPROVED' && review.commit_id === pull.head.sha)) return false;
  return requiredChecks.every(name => checks.some(check => check.name === name && check.app?.id === 15368 && check.status === 'completed' && check.conclusion === 'success' && check.head_sha === pull.head.sha));
}
