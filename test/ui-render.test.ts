import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEntries } from '../src/ui/render';

test('preview renders markdown, thinking and tools while keeping transcript content inert', () => {
  const html = renderEntries([
    { id: '1', ts: 0, role: 'user', text: '**bold** <script>alert(1)</script> [click](command:evil) ![alt](https://example.com/a.png)' },
    { id: '2', ts: 1, role: 'thinking', text: 'Reasoning' },
    { id: '3', ts: 2, role: 'tool', text: '```sh\nrm -rf /\n```' },
  ]);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|href=|<img|src=/);
  assert.match(html, /<details class="entry thinking"/);
  assert.match(html, /<details class="entry tool"/);
});

test('preview does not truncate a loaded transcript beyond 2000 entries', () => {
  const html = renderEntries(Array.from({ length: 2401 }, (_, i) => ({ id: String(i), ts: i, role: 'assistant' as const, text: `message-${i}` })));
  assert.equal((html.match(/<section /g) ?? []).length, 2401);
  assert.match(html, /message-2400/);
});
