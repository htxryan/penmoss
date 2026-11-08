/**
 * The T17 perf harness: the real graph view on a generated vault (default
 * 2,000 notes and 5,000 links; `?notes=&links=`), for graph.spec.ts to
 * measure frames per second in a real browser.
 */
import { GraphView } from '@penmoss/ui/graph/GraphView';
import { syntheticGraph } from '@penmoss/ui/graph/model';
import { createRoot } from 'react-dom/client';
import '../../src/styles.css';
import '../../src/graph/graph.css';

const params = new URLSearchParams(location.search);
const notes = syntheticGraph(
  Number(params.get('notes') ?? 2000),
  Number(params.get('links') ?? 5000),
  Number(params.get('seed') ?? 1),
);
const names = ['Journal', 'Projects', 'Areas', 'Reading', 'Inbox'];
const groups = [...names.map((name) => ({ id: name, name })), { id: null, name: 'Top level' }];

createRoot(document.getElementById('root')!).render(
  <GraphView
    notes={notes}
    groups={groups}
    note={null}
    local={false}
    onLocalChange={() => undefined}
    onOpen={(id) => {
      document.title = `opened ${id}`;
    }}
  />,
);
