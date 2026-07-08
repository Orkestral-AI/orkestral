import { lazy, Suspense } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AppShell } from '@renderer/components/layout/AppShell';

// High-traffic core routes stay eager so first paint is instant.
// IMPORTANT: import each page from its DIRECT module — NOT the '@renderer/pages'
// barrel. The barrel re-exports every page (incl. the heavy editor/flow pages),
// so importing it here would pull all of them back into the main chunk and
// defeat the code-splitting below.
import { Home } from '@renderer/pages/Home';
import { SessionPage } from '@renderer/pages/SessionPage';
import { InboxPage } from '@renderer/pages/InboxPage';
import { DashboardPage } from '@renderer/pages/DashboardPage';
import { IssuesPage } from '@renderer/pages/IssuesPage';
import { IssueDetailPage } from '@renderer/pages/IssueDetailPage';

// Rotinas estão FORA deste MVP — a rota mostra a tela "Em breve" (empty state
// animado, ver RoutinesComingSoon). A RoutinesPage real segue no repo pra reativar
// depois; só não é roteada por enquanto.
const RoutinesComingSoon = lazy(() =>
  import('@renderer/pages/RoutinesComingSoon').then((m) => ({ default: m.RoutinesComingSoon })),
);
const GoalsPage = lazy(() =>
  import('@renderer/pages/GoalsPage').then((m) => ({ default: m.GoalsPage })),
);
const GoalDetailPage = lazy(() =>
  import('@renderer/pages/GoalDetailPage').then((m) => ({ default: m.GoalDetailPage })),
);
const CodeReviewsPage = lazy(() =>
  import('@renderer/pages/CodeReviewsPage').then((m) => ({ default: m.CodeReviewsPage })),
);
const CodeReviewDetailPage = lazy(() =>
  import('@renderer/pages/CodeReviewDetailPage').then((m) => ({
    default: m.CodeReviewDetailPage,
  })),
);
const WorkspaceIdePage = lazy(() =>
  import('@renderer/pages/SourceDetailPage').then((m) => ({ default: m.WorkspaceIdePage })),
);
const KnowledgePage = lazy(() =>
  import('@renderer/pages/KnowledgePage').then((m) => ({ default: m.KnowledgePage })),
);
const KnowledgeGraphPage = lazy(() =>
  import('@renderer/pages/KnowledgeGraphPage').then((m) => ({ default: m.KnowledgeGraphPage })),
);
const ProjectsPage = lazy(() =>
  import('@renderer/pages/ProjectsPage').then((m) => ({ default: m.ProjectsPage })),
);
const AgentsPage = lazy(() =>
  import('@renderer/pages/AgentsPage').then((m) => ({ default: m.AgentsPage })),
);
const AgentPage = lazy(() =>
  import('@renderer/pages/AgentPage').then((m) => ({ default: m.AgentPage })),
);
const OrgPage = lazy(() => import('@renderer/pages/OrgPage').then((m) => ({ default: m.OrgPage })));
const SkillsPage = lazy(() =>
  import('@renderer/pages/SkillsPage').then((m) => ({ default: m.SkillsPage })),
);
const McpsPage = lazy(() =>
  import('@renderer/pages/McpsPage').then((m) => ({ default: m.McpsPage })),
);
const CostsPage = lazy(() =>
  import('@renderer/pages/CostsPage').then((m) => ({ default: m.CostsPage })),
);
const ActivityPage = lazy(() =>
  import('@renderer/pages/ActivityPage').then((m) => ({ default: m.ActivityPage })),
);
const SentryPage = lazy(() =>
  import('@renderer/pages/SentryPage').then((m) => ({ default: m.SentryPage })),
);
const SentryIssueDetailPage = lazy(() =>
  import('@renderer/pages/SentryIssueDetailPage').then((m) => ({
    default: m.SentryIssueDetailPage,
  })),
);
const SentryAutomationsPage = lazy(() =>
  import('@renderer/pages/SentryAutomationsPage').then((m) => ({
    default: m.SentryAutomationsPage,
  })),
);
const ObservabilityPage = lazy(() =>
  import('@renderer/pages/ObservabilityPage').then((m) => ({ default: m.ObservabilityPage })),
);
const ObservabilitySignalDetailPage = lazy(() =>
  import('@renderer/pages/ObservabilitySignalDetailPage').then((m) => ({
    default: m.ObservabilitySignalDetailPage,
  })),
);
const ObservabilityAutomationsPage = lazy(() =>
  import('@renderer/pages/ObservabilityAutomationsPage').then((m) => ({
    default: m.ObservabilityAutomationsPage,
  })),
);
const IntegrationsPage = lazy(() =>
  import('@renderer/pages/IntegrationsPage').then((m) => ({ default: m.IntegrationsPage })),
);
const ProvidersPage = lazy(() =>
  import('@renderer/pages/ProvidersPage').then((m) => ({ default: m.ProvidersPage })),
);
const ChannelsPage = lazy(() =>
  import('@renderer/pages/ChannelsPage').then((m) => ({ default: m.ChannelsPage })),
);
const LogsPage = lazy(() =>
  import('@renderer/pages/LogsPage').then((m) => ({ default: m.LogsPage })),
);

function RouteSpinner() {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
    </div>
  );
}

export function Router() {
  return (
    <HashRouter>
      <AppShell>
        <Suspense fallback={<RouteSpinner />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/session/:sessionId" element={<SessionPage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            {/* Docker virou uma seção do workspace Dev (/sources). Rota antiga redireciona. */}
            <Route path="/docker" element={<Navigate to="/sources" replace />} />
            <Route path="/issues" element={<IssuesPage />} />
            <Route path="/issues/:issueKey" element={<IssueDetailPage />} />
            <Route path="/routines" element={<RoutinesComingSoon />} />
            <Route path="/goals" element={<GoalsPage />} />
            <Route path="/goals/:goalId" element={<GoalDetailPage />} />
            <Route path="/code-reviews" element={<CodeReviewsPage />} />
            <Route
              path="/code-reviews/:repoFullName/:prNumber"
              element={<CodeReviewDetailPage />}
            />
            {/* IDE unificada do workspace — todas as sources numa árvore só (trilho 2). */}
            <Route path="/sources" element={<WorkspaceIdePage />} />
            {/* Rotas antigas por-source redirecionam pro workspace unificado. */}
            <Route path="/sources/:sourceId" element={<Navigate to="/sources" replace />} />
            <Route path="/sources/:sourceId/code" element={<Navigate to="/sources" replace />} />
            <Route path="/knowledge" element={<KnowledgeGraphPage />} />
            <Route path="/knowledge/:pageId" element={<KnowledgePage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/new" element={<ProjectsPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/agents/:agentId" element={<AgentPage />} />
            <Route path="/company/org" element={<OrgPage />} />
            <Route path="/company/skills" element={<SkillsPage />} />
            <Route path="/company/costs" element={<CostsPage />} />
            <Route path="/company/activity" element={<ActivityPage />} />
            <Route path="/mcps" element={<McpsPage />} />
            <Route path="/integrations" element={<IntegrationsPage />} />
            <Route path="/providers" element={<ProvidersPage />} />
            <Route path="/channels" element={<ChannelsPage />} />
            <Route path="/sentry" element={<SentryPage />} />
            <Route path="/sentry/automations" element={<SentryAutomationsPage />} />
            <Route path="/sentry/:issueId" element={<SentryIssueDetailPage />} />
            <Route
              path="/observability/:provider/automations"
              element={<ObservabilityAutomationsPage />}
            />
            <Route
              path="/observability/:provider/:signalId"
              element={<ObservabilitySignalDetailPage />}
            />
            <Route path="/observability/:provider" element={<ObservabilityPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </AppShell>
    </HashRouter>
  );
}
