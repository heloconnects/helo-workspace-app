import { useState } from 'react';
import type { HeloBridge } from '../shared/api.js';
import { ApiContext, useLoad } from './api-context.js';
import { Banner } from './components.js';
import { ConnectionPage } from './screens/ConnectionPage.js';
import { ProjectList } from './screens/ProjectList.js';
import { ProjectPage } from './screens/ProjectPage.js';
import { TaskPage } from './screens/TaskPage.js';

export type Route = { name: 'projects' } | { name: 'project'; id: string } | { name: 'task'; id: string } | { name: 'connection' };

export type Go = (r: Route) => void;

export function App({ api }: { api: HeloBridge }) {
  const [route, setRoute] = useState<Route>({ name: 'projects' });
  return (
    <ApiContext.Provider value={api}>
      <div className="app">
        <Banner />
        <header className="topbar">
          <span className="brand">Helo Workspace</span>
          <nav aria-label="Main">
            <button type="button" className={route.name === 'projects' || route.name === 'project' || route.name === 'task' ? 'nav active' : 'nav'} onClick={() => setRoute({ name: 'projects' })}>
              Projects
            </button>
            <button type="button" className={route.name === 'connection' ? 'nav active' : 'nav'} onClick={() => setRoute({ name: 'connection' })}>
              Connection
            </button>
          </nav>
        </header>
        <ModeLine />
        <main className="content">
          {route.name === 'projects' && <ProjectList go={setRoute} />}
          {route.name === 'project' && <ProjectPage id={route.id} go={setRoute} />}
          {route.name === 'task' && <TaskPage id={route.id} go={setRoute} />}
          {route.name === 'connection' && <ConnectionPage />}
        </main>
        <EventLog />
      </div>
    </ApiContext.Provider>
  );
}

function ModeLine() {
  const { data } = useLoad((api) => api.getMode(), []);
  if (!data) return null;
  return (
    <p className={`modeline mode-${data.mode}`} data-testid="mode-line">
      <strong>{data.mode === 'persistent' ? 'Persistent mode' : 'Showcase mode'}</strong> — {data.note}
      {data.dataDir ? (
        <>
          {' '}
          Store: <code>{data.dataDir}</code>
        </>
      ) : null}
    </p>
  );
}

function EventLog() {
  const { data } = useLoad((api) => api.getEvents(), []);
  if (!data?.length) return null;
  return (
    <footer className="eventlog" aria-label="Simulation log">
      <strong>Simulation log</strong>
      <ul>
        {data.slice(0, 5).map((e, i) => (
          <li key={i}>
            <span className="muted">{new Date(e.at).toLocaleTimeString()}</span> {e.text}
          </li>
        ))}
      </ul>
    </footer>
  );
}
