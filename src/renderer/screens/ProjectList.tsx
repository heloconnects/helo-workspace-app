import { useState } from 'react';
import { BUSINESS_LABEL, type Business } from '../../shared/types.js';
import { useApi, useLoad } from '../api-context.js';
import { ErrorNote, Section } from '../components.js';
import type { Go } from '../App.js';

export const DELETE_NOTE =
  'Removing from the app deletes only the app\'s own records. The app never deletes anything inside the clone, including app-records/. Files already committed stay in git history and on GitHub until you remove them yourself.';

export function ProjectList({ go }: { go: Go }) {
  const api = useApi();
  const projects = useLoad((a) => a.listProjects(), []);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const act = async (p: Promise<{ ok: boolean; error?: string }>) => {
    const r = await p;
    setError(r.ok ? null : (r.error ?? 'Failed'));
    return r.ok;
  };

  return (
    <div>
      <h1>Projects</h1>
      <p className="lede">Each project is one simulated local clone. Everything shown here is fictional; nothing on your disk is read or written.</p>
      <ErrorNote error={error ?? projects.error} />
      <table className="table" aria-label="Projects">
        <thead>
          <tr>
            <th>Name</th>
            <th>Business</th>
            <th>Folder</th>
            <th>Status</th>
            <th>Tasks</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {projects.data?.map((p) => (
            <tr key={p.id} data-testid="project-row">
              <td>
                {renaming?.id === p.id ? (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (await act(api.renameProject({ projectId: p.id, name: renaming.name }))) setRenaming(null);
                    }}
                  >
                    <input aria-label="New project name" value={renaming.name} onChange={(e) => setRenaming({ id: p.id, name: e.target.value })} />
                    <button type="submit">Save name</button>
                  </form>
                ) : (
                  <button type="button" className="link" onClick={() => go({ name: 'project', id: p.id })}>
                    {p.name}
                  </button>
                )}
              </td>
              <td>{BUSINESS_LABEL[p.business]}</td>
              <td>
                <code>{p.folder}</code>
              </td>
              <td>{p.archived ? 'Archived' : p.blocked ? `Blocked: ${p.blocked}` : 'Active'}</td>
              <td>{p.taskCount}</td>
              <td className="actions">
                <button type="button" onClick={() => setRenaming({ id: p.id, name: p.name })}>
                  Rename
                </button>
                <button type="button" onClick={() => act(api.archiveProject({ projectId: p.id, archived: !p.archived }))}>
                  {p.archived ? 'Unarchive' : 'Archive'}
                </button>
                <button type="button" onClick={() => setConfirmDelete(p.id)}>
                  Remove from app
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {confirmDelete && (
        <div className="confirm" role="dialog" aria-label="Remove project from the app">
          <p>{DELETE_NOTE}</p>
          <button
            type="button"
            className="danger"
            onClick={async () => {
              await act(api.deleteProject({ projectId: confirmDelete }));
              setConfirmDelete(null);
            }}
          >
            Remove project from the app
          </button>
          <button type="button" onClick={() => setConfirmDelete(null)}>
            Keep it
          </button>
        </div>
      )}
      <RegisterForm onError={setError} />
    </div>
  );
}

function RegisterForm({ onError }: { onError: (e: string | null) => void }) {
  const api = useApi();
  const folders = useLoad((a) => a.listSimFolders(), []);
  const [folderId, setFolderId] = useState('folder-c');
  const [business, setBusiness] = useState<Business>('fictional-a');
  const [name, setName] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  return (
    <Section
      title="Register a project"
      id="register"
      note="Pick a (simulated) clone folder and its business. The folder needs a RULES.md whose “Business in this repository” line matches. One project per folder and one project per business."
    >
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await api.registerProject({ folderId, business, name, repoConfirmed: confirmed });
          if (r.ok) {
            onError(null);
            setDone(`Registered ${r.value.name}.`);
            setName('');
            setConfirmed(false);
          } else {
            setDone(null);
            onError(r.error);
          }
        }}
      >
        <label>
          Folder (simulated)
          <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            {folders.data?.map((f) => (
              <option key={f.id} value={f.id}>
                {f.path} {f.rulesBusiness ? `— RULES.md: ${BUSINESS_LABEL[f.rulesBusiness]}` : '— no RULES.md'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Business
          <select value={business} onChange={(e) => setBusiness(e.target.value as Business)}>
            {(Object.keys(BUSINESS_LABEL) as Business[]).map((b) => (
              <option key={b} value={b}>
                {BUSINESS_LABEL[b]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Project name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Example Project C" />
        </label>
        <label className="check">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          I confirm which GitHub repository this folder belongs to. The app does not check it.
        </label>
        <button type="submit">Register project</button>
        {done && <p className="ok">{done}</p>}
      </form>
    </Section>
  );
}
