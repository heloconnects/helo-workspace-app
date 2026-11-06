import { useLoad } from '../api-context.js';
import { ErrorNote, RecordStateView, Section } from '../components.js';

const KIND_LABEL = {
  record: 'Record file',
  'outside-review': 'Outside review',
  'temporary-leftover': 'Temporary leftover',
  quarantine: 'Quarantine',
} as const;

/** F5: everything in this task's app-records/ folder, before you commit. */
export function Inventory({ taskId }: { taskId: string }) {
  const { data, error } = useLoad((a) => a.getInventory({ taskId }), [taskId]);
  return (
    <Section title="Before you commit: inventory of app-records/" id="inventory">
      <ErrorNote error={error} />
      {data && (
        <>
          <p className="warn-box" data-testid="inventory-warning">
            {data.warning}
          </p>
          <p className="muted">
            Folder: <code>{data.root}/</code> (simulated; held in memory, nothing on disk)
          </p>
          <h3>Record state of each attempt</h3>
          <ul>
            {data.attempts.map((a) => (
              <li key={a.attemptId}>
                Attempt {a.number}: {a.display} — <RecordStateView record={a.recordState} />
              </li>
            ))}
          </ul>
          <table className="table" aria-label="Inventory">
            <thead>
              <tr>
                <th>Full path</th>
                <th>Kind</th>
                <th>What it holds</th>
                <th>Bytes</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.path} data-testid="inventory-row" className={e.flag ? 'flagged' : undefined}>
                  <td>
                    <code>{e.path}</code>
                  </td>
                  <td>
                    {KIND_LABEL[e.kind]}
                    {e.flag && <div className="flag">{e.flag}</div>}
                  </td>
                  <td>{e.holds}</td>
                  <td>{e.bytes}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.entries.length && <p className="muted">Nothing saved for this task yet.</p>}
        </>
      )}
    </Section>
  );
}
