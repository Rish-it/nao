import { describe, expect, it, vi } from 'vitest';

// The agent stack pulls in bun:sqlite, which the node runner cannot load.
vi.mock('../src/services/agent', () => ({ AgentService: class {} }));

import type { AgentRunResult } from '../src/services/agent';
import { TestAgentService } from '../src/services/test-agent.service';

function agentResultWithQuery(id: string, columns: string[], data: Record<string, unknown>[]): AgentRunResult {
	return {
		steps: [
			{
				toolCalls: [{ toolName: 'execute_sql', toolCallId: 'call_1', input: { sql_query: 'select 1' } }],
				toolResults: [
					{
						toolCallId: 'call_1',
						output: { _version: '1', id, columns, data, row_count: data.length },
					},
				],
			},
		],
	} as unknown as AgentRunResult;
}

describe('TestAgentService.resolveQueryRows', () => {
	it('returns every row of the query, past the 40 rows the transcript shows', () => {
		const data = Array.from({ length: 250 }, (_, index) => ({ country: `c${index}`, total: index }));
		const agentResult = agentResultWithQuery('query_abc123', ['country', 'total'], data);

		const rows = TestAgentService.resolveQueryRows(
			agentResult,
			{ queryId: 'query_abc123', columns: ['country', 'total'] },
			['country', 'total'],
		);

		expect(rows).toHaveLength(250);
		expect(rows?.at(-1)).toEqual({ country: 'c249', total: 249 });
	});

	it('renames the query columns to the expected columns, in order', () => {
		const agentResult = agentResultWithQuery('query_abc123', ['nation', 'revenue'], [{ nation: 'FR', revenue: 7 }]);

		const rows = TestAgentService.resolveQueryRows(
			agentResult,
			{ queryId: 'query_abc123', columns: ['nation', 'revenue'] },
			['country', 'total'],
		);

		expect(rows).toEqual([{ country: 'FR', total: 7 }]);
	});

	it('returns null for an unknown query id so the caller can fall back', () => {
		const agentResult = agentResultWithQuery('query_abc123', ['total'], [{ total: 1 }]);

		expect(TestAgentService.resolveQueryRows(agentResult, { queryId: 'query_zzz', columns: null }, ['total'])).toBe(
			null,
		);
	});
});
