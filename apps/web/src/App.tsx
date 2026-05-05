import { platformName } from '@platforma/shared';

import './styles.css';

export function App() {
  return (
    <main className="app-shell">
      <section className="status-panel" aria-labelledby="app-title">
        <p className="eyebrow">Project scaffold</p>
        <h1 id="app-title">{platformName}</h1>
        <p className="description">
          Frontend workspace is ready. Application routes and closed-platform screens will be
          added in the next stages.
        </p>
      </section>
    </main>
  );
}
