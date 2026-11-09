import type { ReactNode } from 'react';
import { SIMULATION_BANNER, type AttemptState, type RecordState, type SwapBlockView } from '../shared/types.js';

export function Banner() {
  return (
    <div className="sim-banner" role="status" data-testid="sim-banner">
      {SIMULATION_BANNER}
    </div>
  );
}

const TONE: Partial<Record<AttemptState, string>> = {
  complete: 'good',
  needs_attention: 'warn',
  failed: 'bad',
  cancelled: 'muted',
  interrupted: 'bad',
  cancelling: 'warn',
  cancellation_unconfirmed: 'bad',
};

export function StatusBadge({ state, display, damaged }: { state: AttemptState; display: string; damaged?: boolean }) {
  const tone = damaged ? 'bad' : (TONE[state] ?? 'live');
  return (
    <span className={`badge badge-${tone}`} data-testid="status-badge">
      {display}
    </span>
  );
}

export function RecordStateView({ record }: { record: RecordState }) {
  if (record.kind === 'running') return <span className="record record-running">Record state: attempt still running</span>;
  if (record.kind === 'intact') return <span className="record record-intact">Record state: intact</span>;
  if (record.kind === 'unchecked')
    return (
      <div className="record record-damaged" data-testid="record-unchecked">
        <strong>Record state: cannot be checked right now</strong>
        <div>
          <code>{record.path}</code> — {record.error}
        </div>
      </div>
    );
  return (
    <div className="record record-damaged" data-testid="record-damaged">
      <strong>Record state: damaged</strong>
      <ul>
        {record.problems.map((p) => (
          <li key={p.path}>
            <code>{p.path}</code> — {p.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Generated or pasted content is shown as inert text only. Never HTML. */
export function Inert({ text, label }: { text: string; label?: string }) {
  return (
    <pre className="inert" aria-label={label}>
      {text}
    </pre>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="error" role="alert">
      {error}
    </p>
  );
}

export function Section({ title, children, id, note }: { title: string; children: ReactNode; id?: string; note?: ReactNode }) {
  return (
    <section className="section" aria-labelledby={id ? `${id}-h` : undefined}>
      <h2 id={id ? `${id}-h` : undefined}>{title}</h2>
      {note ? <p className="section-note">{note}</p> : null}
      {children}
    </section>
  );
}

export function short(hash: string | null | undefined): string {
  return hash ? `${hash.slice(0, 12)}…` : '—';
}

export function List({ items, empty = 'None' }: { items: string[]; empty?: string }) {
  if (!items.length) return <p className="muted">{empty}</p>;
  return (
    <ul>
      {items.map((i, n) => (
        <li key={n}>{i}</li>
      ))}
    </ul>
  );
}

/**
 * Plan revision 9, "block and warn": what was detected, where, whether the entry was moved back,
 * and the one action that lifts the block.
 */
export function SwapBlockNotice({ block, onChecked }: { block: SwapBlockView; onChecked: () => void }) {
  return (
    <div className="warn-box" role="alert" data-testid="swap-block">
      <strong>{block.advice}</strong>
      <p>
        Folder: <code>{block.folder}</code>
        <br />
        Moved from <code>{block.sourceName}</code> to <code>{block.destinationName}</code>, detected {block.detectedAt}
        {block.during === 'quarantine' ? ' (while moving a file to quarantine)' : block.during === 'outside-review' ? ' (while saving an outside review)' : ' (while saving a task record)'}.
      </p>
      <p>
        {block.movedBack
          ? 'The entry that was swapped in was moved back to its original name.'
          : `The entry that was swapped in could NOT be moved back. It may still be at ${block.destinationName}.`}{' '}
        Nothing was published from that write. No task or write runs in this project until you have checked the folder.
      </p>
      <p className="muted">{block.error}</p>
      <button type="button" onClick={onChecked}>
        I have checked this folder
      </button>
    </div>
  );
}
