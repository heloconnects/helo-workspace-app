import { useLoad } from '../api-context.js';
import { ErrorNote, Section } from '../components.js';

export function ConnectionPage() {
  const { data, error } = useLoad((a) => a.getConnection(), []);
  return (
    <div>
      <h1>Connection</h1>
      <ErrorNote error={error} />
      {data && (
        <>
          <p className="warn-box">{data.note}</p>
          <div className="cards">
            {data.providers.map((p) => (
              <Section key={p.provider} title={p.label} id={`conn-${p.provider}`}>
                <dl className="dl">
                  <dt>Adapter</dt>
                  <dd>{p.adapter}</dd>
                  <dt>Provider program</dt>
                  <dd>{p.executable}</dd>
                  <dt>Signed in</dt>
                  <dd>{p.signedIn}</dd>
                  <dt>Diagnostic</dt>
                  <dd>{p.diagnostic}</dd>
                </dl>
              </Section>
            ))}
          </div>
          <Section title="Compatibility checklist" id="checklist" note="Every blank is UNVERIFIED. Live use stays blocked until each row is settled and separately approved.">
            <table className="table" aria-label="Compatibility checklist">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Codex</th>
                  <th>Claude</th>
                </tr>
              </thead>
              <tbody>
                {data.checklist.map((r) => (
                  <tr key={r.check}>
                    <td>{r.check}</td>
                    <td>{r.codex}</td>
                    <td>{r.claude}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </>
      )}
    </div>
  );
}
