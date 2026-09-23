import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialPanel, selectionPanel } from '../src/ui/state.ts';

test('blank document without bridge or workspace has useful offline views', () => {
  const panel = initialPanel();
  assert.deepEqual(panel.tabs.map(tab => tab.title), ['Selection', 'Mappings', 'Preview and changes', 'Connection']);
  assert.match(panel.selection, /select a frame/i);
  assert.match(panel.selection, /create a design/i);
  assert.match(panel.selection, /create sample design.*unavailable/i);
  assert.match(panel.mappings, /catalog.*unavailable/i);
  assert.match(panel.preview, /preview.*local bridge/i);
  assert.match(panel.preview, /publish.*local bridge/i);
  assert.match(panel.connection, /offline.*no workspace/i);
  assert.match(panel.connection, /not connected/i);
});

test('selection is reflected without claiming export support', () => {
  assert.match(selectionPanel(['Frame A']), /Frame A/);
  assert.match(selectionPanel(['Frame A']), /export.*unavailable/i);
  assert.match(selectionPanel([]), /select a frame/i);
});
