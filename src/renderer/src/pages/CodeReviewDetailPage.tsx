import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useT } from '@renderer/i18n';
import { PageShell, ReviewDetailPane } from './CodeReviewsPage';

export function CodeReviewDetailPage() {
  const { t } = useT();
  const params = useParams<{
    prNumber: string;
    repoFullName?: string;
  }>();
  const navigate = useNavigate();
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const prNumber = Number(params.prNumber);
  // O `repoFullName` é URL-encoded ("owner%2Frepo"). Decodifica.
  const targetRepo = params.repoFullName ? decodeURIComponent(params.repoFullName) : null;

  // Lista todos os PRs de todos os sources do workspace
  const allPrsQuery = useQuery({
    queryKey: ['source-all-prs', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['source:list-all-prs']({ workspaceId: activeWorkspace!.id }),
  });

  const groups = allPrsQuery.data ?? [];
  // Se a URL trouxe o repo, casamos exato. Senão pega o primeiro source que tem esse PR.
  const matchedGroup = targetRepo
    ? groups.find((g) => g.repoFullName === targetRepo)
    : groups.find((g) => g.prs.some((p) => p.number === prNumber));
  const pr = matchedGroup?.prs.find((p) => p.number === prNumber);

  const back = () => navigate('/code-reviews');

  if (!activeWorkspace) {
    return (
      <PageShell
        title={t('pages.codeReviews.codeReviewTitle')}
        description={t('pages.codeReviews.noActiveWorkspace')}
        back={back}
      >
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('pages.codeReviews.noActiveWorkspaceDot')}
        </div>
      </PageShell>
    );
  }

  if (allPrsQuery.isPending) {
    return (
      <PageShell title={t('pages.codeReviews.loadingTitle')} description="" back={back}>
        <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('pages.codeReviews.fetchingPr')}
        </div>
      </PageShell>
    );
  }

  if (groups.length === 0) {
    return (
      <PageShell
        title={t('pages.codeReviews.codeReviewTitle')}
        description={t('pages.codeReviews.workspaceNoGithub')}
        back={back}
      >
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('pages.codeReviews.noGithubSourceDetail')}
        </div>
      </PageShell>
    );
  }

  if (!pr || !matchedGroup) {
    return (
      <PageShell
        title={t('pages.codeReviews.prNumber', { n: prNumber })}
        description={targetRepo ?? t('pages.codeReviews.notFound')}
        back={back}
      >
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {targetRepo
            ? t('pages.codeReviews.prNotFoundIn', { n: prNumber, repo: targetRepo })
            : `${t('pages.codeReviews.prNotFound', { n: prNumber })}.`}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell title={`PR #${pr.number}`} description={matchedGroup.repoFullName} back={back}>
      <ReviewDetailPane
        workspaceId={activeWorkspace.id}
        repoFullName={matchedGroup.repoFullName}
        prNumber={pr.number}
        prTitle={pr.title}
        prHtmlUrl={pr.htmlUrl}
      />
    </PageShell>
  );
}
