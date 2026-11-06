import { useEffect, useState } from 'react';
import type { ComposeInput } from '../../shared/api.js';
import { BUSINESS_LABEL, DEFAULT_DRAFTER, PROVIDER_LABEL, otherProvider, type Provider, type SharingPlanView } from '../../shared/types.js';
import { useApi, useLoad } from '../api-context.js';
import { ErrorNote, Inert, Section, StatusBadge } from '../components.js';
import type { Go } from '../App.js';

export function ProjectPage({ id, go }: { id: string; go: Go }) {
  const projects = useLoad((a) => a.listProjects(), []);
  const tasks = useLoad((a) => a.listTasks({ projectId: id }), [id]);
  const p = projects.data?.find((x) => x.id === id);
  if (!p) return <ErrorNote error={projects.error ?? (projects.data ? 'Project not found.' : null)} />;

  return (
    <div>
      <p className="crumbs">
        <button type="button" className="link" onClick={() => go({ name: 'projects' })}>
          Projects
        </button>{' '}
        / {p.name}
      </p>
      <h1>{p.name}</h1>
      <p className="lede">
        {BUSINESS_LABEL[p.business]} · <code>{p.folder}</code> {p.archived && <strong>· Archived: cannot start tasks</strong>}
      </p>
      <ErrorNote error={p.blocked} />

      <Section title="Tasks" id="tasks">
        <ErrorNote error={tasks.error} />
        {tasks.data?.length ? (
          <table className="table" aria-label="Tasks">
            <thead>
              <tr>
                <th>Task</th>
                <th>Drafter</th>
                <th>Latest attempt</th>
              </tr>
            </thead>
            <tbody>
              {tasks.data.map((t) => (
                <tr key={t.id} data-testid="task-row">
                  <td>
                    <button type="button" className="link" onClick={() => go({ name: 'task', id: t.id })}>
                      {t.title}
                    </button>
                  </td>
                  <td>{PROVIDER_LABEL[t.drafter]}</td>
                  <td>
                    {t.latest ? (
                      <StatusBadge state={t.latest.state} display={t.latest.display} damaged={t.latest.recordState.kind === 'damaged'} />
                    ) : (
                      <span className="muted">Not started: review sharing first</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No tasks yet.</p>
        )}
      </Section>

      {!p.archived && !p.blocked && <Composer projectId={p.id} sources={p.sources} go={go} />}

      <Section title="Project instructions (RULES.md, simulated)" id="rules">
        <Inert text={p.instructions} label="RULES.md" />
      </Section>
    </div>
  );
}

function Composer({ projectId, sources, go }: { projectId: string; sources: { sourceId: string; path: string; bytes: number }[]; go: Go }) {
  const api = useApi();
  const scenarios = useLoad((a) => a.listScenarios(), []);
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [criteria, setCriteria] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [drafter, setDrafter] = useState<Provider>(DEFAULT_DRAFTER);
  const [scenarioId, setScenarioId] = useState('success-issues');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SharingPlanView | null>(null);

  const input: ComposeInput = {
    projectId,
    title,
    brief,
    acceptanceCriteria: criteria.split('\n').map((c) => c.trim()).filter(Boolean),
    sourceIds: selected,
    drafter,
    scenarioId,
  };

  useEffect(() => {
    let live = true;
    void api.previewSharing(input).then((r) => {
      if (live && r.ok) setPreview(r.value);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId, drafter, selected.join('|'), scenarioId]);

  return (
    <Section title="New task" id="composer" note="Enter the task once. The drafter drafts, the other provider reviews, and the drafter writes the synthesis in a fresh session.">
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await api.createTask(input);
          if (r.ok) go({ name: 'task', id: r.value.taskId });
          else setError(r.error);
        }}
      >
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Example: a made-up task" />
        </label>
        <label>
          Brief
          <textarea rows={4} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Example brief for a made-up task." />
        </label>
        <label>
          Acceptance criteria (one per line)
          <textarea rows={3} value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder="Example criterion" />
        </label>
        <fieldset>
          <legend>Context files from this project&apos;s folder (explicitly selected; frozen when the task is created)</legend>
          {sources.length === 0 && (
            <p className="muted">No selectable context files. (Importing files from a real test folder is not part of persistence v1.) RULES.md is always included.</p>
          )}
          {sources.map((s) => (
            <label key={s.sourceId} className="check">
              <input
                type="checkbox"
                checked={selected.includes(s.sourceId)}
                onChange={(e) => setSelected(e.target.checked ? [...selected, s.sourceId] : selected.filter((x) => x !== s.sourceId))}
              />
              <code>{s.path}</code> <span className="muted">({s.bytes} bytes)</span>
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Role order for this task</legend>
          {(['claude', 'codex'] as const).map((p) => (
            <label key={p} className="check">
              <input type="radio" name="drafter" value={p} checked={drafter === p} onChange={() => setDrafter(p)} />
              {PROVIDER_LABEL[p]} drafts{p === DEFAULT_DRAFTER ? ' (default)' : ''}
            </label>
          ))}
          <p className="muted" data-testid="role-summary">
            Drafter: {PROVIDER_LABEL[drafter]} · Reviewer: {PROVIDER_LABEL[otherProvider(drafter)]} (always the other provider) · Synthesis: {PROVIDER_LABEL[drafter]}
          </p>
        </fieldset>
        <label className="sim-control">
          Simulation: how the fake adapters behave
          <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} aria-label="Simulation scenario">
            {scenarios.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {preview && <SharingSteps plan={preview} heading="Sharing this task would need" />}
        <ErrorNote error={error} />
        <button type="submit">Create task and review sharing</button>
      </form>
    </Section>
  );
}

export function SharingSteps({ plan, heading }: { plan: SharingPlanView; heading: string }) {
  return (
    <div className="sharing" data-testid="sharing-steps">
      <h3>{heading}</h3>
      <ol>
        {plan.steps.map((s) => (
          <li key={s.order}>
            <strong>
              {s.order}. {s.stage[0]!.toUpperCase() + s.stage.slice(1)}
            </strong>{' '}
            — {s.providerLabel} receives {s.receives}.
          </li>
        ))}
      </ol>
      <p className="sharing-sentence" data-testid="sharing-sentence">
        {plan.sentence}
      </p>
      <p className="muted">In this simulation nothing is sent anywhere: the fake adapters run inside the app.</p>
    </div>
  );
}
