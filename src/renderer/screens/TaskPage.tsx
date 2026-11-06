import { useRef, useState } from 'react';
import {
  DISPATCH_LABEL,
  OUTCOME_LABEL,
  PROVIDER_LABEL,
  STAGE_NUMBER,
  STAGE_TITLE,
  type AttemptView,
  type StageView,
  type TaskView,
} from '../../shared/types.js';
import { useApi, useLoad } from '../api-context.js';
import { ErrorNote, Inert, List, RecordStateView, Section, short, StatusBadge } from '../components.js';
import type { Go } from '../App.js';
import { Inventory } from './Inventory.js';
import { DELETE_NOTE } from './ProjectList.js';
import { SharingSteps } from './ProjectPage.js';

export function TaskPage({ id, go }: { id: string; go: Go }) {
  const { data: t, error } = useLoad((a) => a.getTask({ taskId: id }), [id]);
  if (!t) return <ErrorNote error={error} />;
  const attempts = [...t.attempts].reverse();
  return (
    <div>
      <p className="crumbs">
        <button type="button" className="link" onClick={() => go({ name: 'projects' })}>
          Projects
        </button>{' '}
        /{' '}
        <button type="button" className="link" onClick={() => go({ name: 'project', id: t.projectId })}>
          {t.projectName}
        </button>{' '}
        / {t.title}
      </p>
      <h1>{t.title}</h1>
      <p className="lede" data-testid="task-roles">
        Drafter: {PROVIDER_LABEL[t.roles.drafter]} · Reviewer: {PROVIDER_LABEL[t.roles.reviewer]} · Synthesis: {PROVIDER_LABEL[t.roles.synthesizer]}
      </p>
      <ErrorNote error={error} />

      <Brief t={t} />
      <SharingAndStart t={t} />

      {attempts.map((a) => (
        <AttemptCard key={a.id} a={a} />
      ))}

      {t.attempts.some((a) => a.outcome === 'complete' || a.outcome === 'needs_attention') && <Results t={t} />}

      <Inventory taskId={t.id} />
      <OutsideReviews t={t} />
      <SimulationControls t={t} />
      <DeleteTask t={t} go={go} />
    </div>
  );
}

function Brief({ t }: { t: TaskView }) {
  return (
    <Section title="Brief and context manifest" id="brief">
      <Inert text={t.brief} label="Brief" />
      <h3>Acceptance criteria</h3>
      <List items={t.acceptanceCriteria} />
      <h3>Selected sources (snapshots frozen in P)</h3>
      <table className="table" aria-label="Context manifest">
        <thead>
          <tr>
            <th>ID</th>
            <th>File in the clone</th>
            <th>SHA-256</th>
            <th>Bytes</th>
          </tr>
        </thead>
        <tbody>
          {t.sources.map((s) => (
            <tr key={s.sourceId}>
              <td>{s.sourceId}</td>
              <td>
                <code>{s.displayName}</code>
              </td>
              <td>
                <code>{short(s.sha256)}</code>
              </td>
              <td>{s.bytes}</td>
            </tr>
          ))}
          <tr>
            <td>RULES</td>
            <td>
              <code>RULES.md</code> (project instructions, below the app boundary policy)
            </td>
            <td colSpan={2} />
          </tr>
        </tbody>
      </table>
      <p className="muted">
        Packet P SHA-256: <code>{short(t.packetHash)}</code> · Simulation scenario: {t.scenarioLabel}
      </p>
    </Section>
  );
}

function SharingAndStart({ t }: { t: TaskView }) {
  const api = useApi();
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(`start-${t.id}-${Date.now()}`);
  const first = t.attempts.length === 0;
  return (
    <Section title={first ? 'Sharing screen: review before the first attempt' : 'Sharing screen and new attempt'} id="sharing">
      <SharingSteps plan={t.sharing} heading="Before execution, in this attempt's frozen order" />
      <p>
        Approving covers the selected task sources, the drafter&apos;s draft going to the reviewer&apos;s provider, and the review returning to the
        drafter&apos;s provider. It does not cover changed context, future tasks, or any live call.
      </p>
      {!first && <p className="muted">A new attempt re-runs all three stages from the same frozen packet, under a new attempt ID. Earlier attempts are kept.</p>}
      {t.needsStopAcknowledgement && (
        <label className="check warn-box">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          An earlier attempt may still have a provider stage running: it was dispatched and never confirmed stopped. I confirm the earlier activity has
          stopped. Starting again may cause duplicate billing (with real providers).
        </label>
      )}
      <ErrorNote error={error ?? t.startBlockedReason} />
      <button
        type="button"
        className="primary"
        disabled={!t.canStartAttempt}
        onClick={async () => {
          const r = await api.startAttempt({ taskId: t.id, approvedPacketHash: t.packetHash, idempotencyKey: key.current, acknowledgePriorStopped: ack });
          if (r.ok) {
            setError(null);
            key.current = `start-${t.id}-${Date.now()}`;
          } else setError(r.error);
        }}
      >
        {first ? 'Approve sharing and start (simulated)' : 'Approve sharing and start new attempt (simulated)'}
      </button>
    </Section>
  );
}

function AttemptCard({ a }: { a: AttemptView }) {
  const api = useApi();
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="section attempt" aria-label={`Attempt ${a.number}`} data-testid="attempt">
      <div className="attempt-head">
        <h2>Attempt {a.number}</h2>
        <StatusBadge state={a.state} display={a.display} damaged={a.recordState.kind === 'damaged'} />
      </div>
      <p>
        <strong>Outcome:</strong> {a.outcome ? OUTCOME_LABEL[a.outcome] : 'not decided yet'}
        {a.completionLabel && a.recordState.kind !== 'damaged' ? ` (${a.completionLabel})` : ''}
      </p>
      <RecordStateView record={a.recordState} />
      {a.reason && <p className="reason">{a.reason}</p>}
      {a.state === 'cancellation_unconfirmed' && (
        <p className="warn-box">
          Cancellation unconfirmed. Retry is blocked until this is resolved. Local cancellation does not promise that remote generation or billing stopped.
        </p>
      )}
      <div className="stages">
        {a.stages.map((s) => (
          <StageCard key={s.stage} s={s} />
        ))}
      </div>
      {a.lateResults.length > 0 && (
        <div className="late">
          <strong>Late results (quarantined, never used):</strong>
          <List items={a.lateResults.map((l) => `${STAGE_TITLE[l.stage]}: ${l.note}`)} />
        </div>
      )}
      <p className="muted">Usage: {a.usage}</p>
      <ErrorNote error={error} />
      <div className="actions">
        {a.canCancel && (
          <button
            type="button"
            onClick={async () => {
              const r = await api.cancelAttempt({ attemptId: a.id });
              setError(r.ok ? null : r.error);
            }}
          >
            Cancel attempt
          </button>
        )}
        {a.canResolveCancellation && (
          <button
            type="button"
            onClick={async () => {
              const r = await api.resolveCancellation({ attemptId: a.id });
              setError(r.ok ? null : r.error);
            }}
          >
            Resolve: I confirmed the owned process stopped (simulated)
          </button>
        )}
      </div>
    </section>
  );
}

function StageCard({ s }: { s: StageView }) {
  return (
    <article className="stage" aria-label={`${STAGE_TITLE[s.stage]} by ${s.providerLabel}`} data-testid={`stage-${s.stage}`}>
      <h3>
        {STAGE_NUMBER[s.stage]}. {STAGE_TITLE[s.stage]}
      </h3>
      <p className="provider-label" data-testid={`stage-${s.stage}-provider`}>
        Produced by {s.providerLabel} — simulated adapter
      </p>
      <p className="meta">
        <span className={`dispatch dispatch-${s.dispatch}`}>{DISPATCH_LABEL[s.dispatch]}</span>
        {s.activityUnresolved && (
          <>
            {' '}
            · <span className="dispatch dispatch-uncertain">Not confirmed stopped</span>
          </>
        )}
        {s.payloadHash && (
          <>
            {' '}
            · Prepared payload <code>{short(s.payloadHash)}</code>
          </>
        )}
        {s.reportedModel && (
          <>
            {' '}
            · Requested {s.requestedModel}; reported {s.reportedProvider} / {s.reportedModel}
          </>
        )}
      </p>
      {s.rejection && <p className="error">Output rejected (not shown as a result and not forwarded): {s.rejection}</p>}
      {s.output?.kind === 'draft' && (
        <>
          <Inert text={s.output.draft} label="Draft text" />
          <h4>Assumptions</h4>
          <List items={s.output.assumptions} />
          <h4>Limitations</h4>
          <List items={s.output.limitations} />
        </>
      )}
      {s.output?.kind === 'review' && (
        <>
          <p>
            <strong>Verdict:</strong> {s.output.verdict}
          </p>
          <h4>Findings</h4>
          <List items={s.output.findings.map((f) => `${f.id} (${f.severity}): ${f.text} Evidence: ${f.evidence}`)} empty="No findings" />
          <h4>Unresolved</h4>
          <List items={s.output.unresolved} />
        </>
      )}
      {s.output?.kind === 'synthesis' && (
        <>
          <Inert text={s.output.deliverable} label="Synthesis text" />
          <h4>Disposition of every review finding</h4>
          <List items={s.output.dispositions.map((d) => `${d.findingId}: ${d.disposition}. ${d.note}`)} empty="No findings to dispose of" />
          <h4>Remaining issues</h4>
          <List items={s.output.remainingIssues} empty="None reported" />
          <h4>Acceptance criteria</h4>
          <List items={s.output.criteriaAssessment.map((c) => `${c.met ? 'Met' : 'Not met'}: ${c.criterion}. ${c.note}`)} />
        </>
      )}
      {!s.output && !s.rejection && <p className="muted">No output.</p>}
      <p className="muted small">
        Task record — saved by the app: <code>{s.sentFile.split('/').pop()}</code>
        {s.output ? (
          <>
            , <code>{s.outputFile.split('/').pop()}</code>
          </>
        ) : null}
      </p>
    </article>
  );
}

function Results({ t }: { t: TaskView }) {
  const api = useApi();
  const [exported, setExported] = useState<string | null>(null);
  const done = [...t.attempts].reverse().find((a) => a.outcome === 'complete' || a.outcome === 'needs_attention')!;
  const synth = done.stages.find((s) => s.stage === 'synthesis')?.output;
  return (
    <Section title="Review results and export" id="results" note="Completion does not mean the deliverable is factually verified or accepted. Your acceptance is separate.">
      <div className="two-writes">
        <div>
          <h3>Task record — saved by the app</h3>
          <p>
            Plain files under <code>app-records/</code> in the clone, never committed or pushed by the app. In this simulation they are kept in memory only;
            nothing is written to disk.
          </p>
        </div>
        <div>
          <h3>Proposed changes — text only</h3>
          <p>Shown as text only. The app never writes, commits or pushes project files, and never modifies existing project files.</p>
          {synth?.kind === 'synthesis' ? <Inert text={synth.deliverable} label="Proposed changes text" /> : <p className="muted">No synthesis.</p>}
        </div>
      </div>
      <button
        type="button"
        onClick={async () => {
          const r = await api.exportArtifacts({ taskId: t.id });
          setExported(r.ok ? r.value.text : r.error);
        }}
      >
        Export artifacts
      </button>
      {exported && (
        <>
          <p className="muted">Export is simulated: no save dialog opens and no file is written.</p>
          <Inert text={exported} label="Export preview" />
        </>
      )}
    </Section>
  );
}

function OutsideReviews({ t }: { t: TaskView }) {
  const api = useApi();
  const [source, setSource] = useState<'chatgpt' | 'claude-app'>('chatgpt');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Section title="Add outside review" id="outside" note="Paste an answer from ChatGPT or the Claude app. It is saved as its own numbered file, never edited, and never counted as a provider stage.">
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await api.saveOutsideReview({ taskId: t.id, source, text });
          if (r.ok) {
            setText('');
            setError(null);
          } else setError(r.error);
        }}
      >
        <label>
          Source
          <select value={source} onChange={(e) => setSource(e.target.value as 'chatgpt' | 'claude-app')}>
            <option value="chatgpt">ChatGPT</option>
            <option value="claude-app">Claude app</option>
          </select>
        </label>
        <label>
          Pasted review
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste a made-up outside review here." />
        </label>
        <ErrorNote error={error} />
        <button type="submit">Save outside review</button>
      </form>
      {t.outsideReviews.map((o) => (
        <div key={o.saveId} className="outside" data-testid="outside-review">
          <p>
            <strong>Pasted by Ahmed; source not verified by the app</strong> · {o.source === 'chatgpt' ? 'ChatGPT' : 'Claude app'} · {o.state}
            {o.path && (
              <>
                {' '}
                · <code>{o.path}</code>
              </>
            )}
          </p>
          {o.note && <p className="error">{o.note}</p>}
          {o.text && <Inert text={o.text} label="Outside review text" />}
        </div>
      ))}
    </Section>
  );
}

function SimulationControls({ t }: { t: TaskView }) {
  const api = useApi();
  const [file, setFile] = useState('2-review.md');
  const [mode, setMode] = useState<'delete' | 'alter'>('delete');
  const [msg, setMsg] = useState<string | null>(null);
  const last = t.attempts[t.attempts.length - 1];
  return (
    <Section title="Simulation controls" id="sim" note="These exist only in the simulation, to show recovery and record states.">
      <div className="actions">
        <button
          type="button"
          onClick={async () => {
            const r = await api.simulateCrashAndRestart();
            setMsg(r.ok ? `Simulated crash and restart: recovery marked ${r.value.recovered} attempt(s) interrupted.` : r.error);
          }}
        >
          Simulate app crash and restart
        </button>
      </div>
      {last && (
        <form
          className="form inline"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await api.simulateDamage({ attemptId: last.id, file, mode });
            setMsg(r.ok ? `Attempt ${last.number}: ${file} ${mode === 'delete' ? 'deleted' : 'changed'} outside the app.` : r.error);
          }}
        >
          <label>
            Record file of attempt {last.number}
            <select value={file} onChange={(e) => setFile(e.target.value)}>
              {['packet.md', 'sharing-plan.json', '1-draft-sent.json', '1-draft.md', '2-review-sent.json', '2-review.md', '3-synthesis-sent.json', '3-synthesis.md', 'final-status.json'].map(
                (f) => (
                  <option key={f}>{f}</option>
                ),
              )}
            </select>
          </label>
          <label>
            Change
            <select value={mode} onChange={(e) => setMode(e.target.value as 'delete' | 'alter')}>
              <option value="delete">Delete it</option>
              <option value="alter">Change its content</option>
            </select>
          </label>
          <button type="submit">Damage record file</button>
        </form>
      )}
      {msg && <p className="muted">{msg}</p>}
    </Section>
  );
}

function DeleteTask({ t, go }: { t: TaskView; go: Go }) {
  const api = useApi();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Section title="Remove task from the app" id="delete">
      <p className="muted">{DELETE_NOTE}</p>
      {!confirm ? (
        <button type="button" onClick={() => setConfirm(true)}>
          Remove task from the app
        </button>
      ) : (
        <button
          type="button"
          className="danger"
          onClick={async () => {
            const r = await api.deleteTask({ taskId: t.id });
            if (r.ok) go({ name: 'project', id: t.projectId });
            else setError(r.error);
          }}
        >
          Confirm: remove from the app only
        </button>
      )}
      <ErrorNote error={error} />
    </Section>
  );
}
