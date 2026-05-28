import {CompiledSchema} from './schema.ts';
import {RowReader} from './row-reader.ts';
import {demoSchema, DEMO_ROW_JSON} from './demo-schema.ts';

const schema = new CompiledSchema(demoSchema);
const worker = new Worker(new URL('./worker.ts', import.meta.url), {type: 'module'});

worker.onmessage = ({data: {buffer}}: MessageEvent<{buffer: ArrayBuffer}>) => {
  const row = new RowReader(schema, buffer);
  const result = {
    name: row.get('name'),
    score: row.get('score'),
    active: row.get('active'),
    metadata: row.get('metadata'),
    id: String(row.get('id')), // BigInt -> string for display
  };
  console.log('row decoded from worker buffer:', result);
  const el = document.getElementById('out');
  if (el) el.textContent = JSON.stringify(result, null, 2);
};

worker.postMessage({type: 'serialize', rowJson: DEMO_ROW_JSON});
