import { describe, it, expect } from '@jest/globals';
import axios from 'axios';
import { HAOpsApiClient, HAOpsApiError } from './api/client.js';
import {
  buildErrorMessage,
  ERROR_DETAIL_MAX_CHARS,
  ERROR_DETAIL_MAX_ITEMS,
} from './api/errorDetail.js';
import { LAZY_LOG_HINT, formatLazyLogHeader } from './memoryFormat.js';

/** Drives the real HAOpsApiClient.handleError with a stubbed axios adapter (no network). */
async function failWith(status: number, body: unknown): Promise<HAOpsApiError> {
  const client = new HAOpsApiClient('http://127.0.0.1:9', 'dummy');
  const inner = (client as unknown as { axios: ReturnType<typeof axios.create> }).axios;
  inner.defaults.adapter = async (config) => {
    const response = { data: body, status, statusText: 'x', headers: {}, config };
    throw new axios.AxiosError('Request failed', 'ERR_BAD_REQUEST', config, null, response as never);
  };
  try {
    await client.request('PATCH', '/api/projects/p/diagrams/d', {});
  } catch (e) {
    return e as HAOpsApiError;
  }
  throw new Error('expected request to fail');
}

describe('HAOpsApiClient.handleError surfaces 4xx body detail', () => {
  it('400 {error,message,violations} reaches the message with the element id and the fix', async () => {
    const err = await failWith(400, {
      error: 'Diagram contract violation',
      message: 'Fix the listed elements and retry',
      violations: [{ elementId: 'node_ab12cd34', rule: 'UNKNOWN_FIELD', fix: 'remove data.foo' }],
      warnings: ['edge_9 has no label'],
    });
    expect(err).toBeInstanceOf(HAOpsApiError);
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('Diagram contract violation');
    expect(err.message).toContain('Fix the listed elements and retry');
    expect(err.message).toContain('node_ab12cd34');
    expect(err.message).toContain('remove data.foo');
    expect(err.message).toContain('edge_9 has no label');
    expect((err.response as { violations: unknown[] }).violations).toHaveLength(1);
  });

  it('body with only {error} keeps the old message exactly', async () => {
    const err = await failWith(404, { error: 'Not found' });
    expect(err.message).toBe('Not found');
  });

  it('non-object body falls back to the axios message', async () => {
    const err = await failWith(502, '<html>bad gateway</html>');
    expect(err.message).toBe('Request failed');
  });
});

describe('buildErrorMessage caps', () => {
  it('caps the appended detail length', () => {
    const msg = buildErrorMessage({ error: 'E', message: 'x'.repeat(50_000) }, 'fb');
    expect(msg.startsWith('E — ')).toBe(true);
    expect(msg.length).toBeLessThan(ERROR_DETAIL_MAX_CHARS + 60);
    expect(msg).toContain('(truncated)');
  });

  it('caps the number of listed violations', () => {
    const violations = Array.from({ length: 40 }, (_, i) => `v${i}`);
    const msg = buildErrorMessage({ error: 'E', violations }, 'fb');
    expect(msg).toContain('v0');
    expect(msg).toContain(`v${ERROR_DETAIL_MAX_ITEMS - 1}`);
    expect(msg).not.toContain(`v${ERROR_DETAIL_MAX_ITEMS};`);
    expect(msg).toContain(`(+${40 - ERROR_DETAIL_MAX_ITEMS} more)`);
  });

  it('does not repeat message when it equals error; ignores empty lists', () => {
    expect(buildErrorMessage({ error: 'Same', message: 'Same', violations: [] }, 'fb')).toBe('Same');
  });
});

describe('lazy memory header lines', () => {
  const base = { author: 'architect', content: 'BODY-SHOULD-NOT-APPEAR', integrated: false };

  it('prints the entry id', () => {
    const line = formatLazyLogHeader({ ...base, id: 'e-123', timestamp: '2026-11-12T10:00:00Z', tag: 'progress' });
    expect(line).toBe('- [2026-11-12T10:00:00Z] [progress] by architect · id e-123');
    expect(line).not.toContain('BODY-SHOULD-NOT-APPEAR');
  });

  it('adds the title when present', () => {
    const line = formatLazyLogHeader({
      ...base, id: 'e-9', timestamp: 't', tag: 'decision', title: 'Supersede stays in one entity',
    });
    expect(line).toContain('id e-9');
    expect(line).toContain('"Supersede stays in one entity"');
  });

  it('footer hint points at full:true, not at a call that returns headers', () => {
    expect(LAZY_LOG_HINT).toContain('full:true');
    expect(LAZY_LOG_HINT).not.toContain('without mode:"lazy")');
  });
});
