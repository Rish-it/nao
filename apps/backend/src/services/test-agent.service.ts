import type { executeSql } from '@nao/shared/tools';
import type { LlmSelectedModel } from '@nao/shared/types';
import { generateText, ModelMessage, Output } from 'ai';
import { z } from 'zod/v4';

import { llmTelemetry } from '../agents/telemetry';
import type { UIMessage } from '../types/chat';
import type { ModelCosts } from '../types/llm';
import { AgentRunResult, AgentService } from './agent';

type VerificationData = Record<string, string | number | boolean | null>[] | null;

export interface ToolCallResult {
	toolName: string;
	toolCallId: string;
	args: Record<string, unknown>;
	result?: unknown;
}

export class TestAgentService extends AgentService {
	/**
	 * Run a single prompt without persisting to a chat.
	 * Used for testing/evaluation purposes.
	 */
	async runTest(
		projectId: string,
		prompt: string,
		modelSelection?: LlmSelectedModel,
		costs?: ModelCosts,
	): Promise<AgentRunResult> {
		const userMessage = TestAgentService._buildUserMessage(prompt);

		const tempChat = {
			id: crypto.randomUUID(),
			title: 'Test',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			messages: [userMessage],
			userId: 'test',
			projectId,
			testMode: true,
		};

		const agent = await this.create(tempChat, modelSelection);
		return agent.generate([userMessage], { costs });
	}

	/**
	 * Run a verification prompt to extract structured data from the agent's response.
	 * Uses the responseMessages directly from the agent result to avoid double transformation.
	 *
	 * The model only picks which query result answers the question; the rows come from
	 * the raw execute_sql output, which is never truncated the way the transcript is.
	 */
	async runVerification(
		projectId: string,
		agentResult: AgentRunResult,
		expectedColumns: string[],
		modelSelection?: LlmSelectedModel,
	): Promise<{ data: VerificationData }> {
		const resolvedSelectedModel = await this._getResolvedLlmSelectedModel(projectId, modelSelection);
		const modelConfig = await this._getModelConfig(projectId, resolvedSelectedModel);

		// Use responseMessages directly and append verification request
		const messages: ModelMessage[] = [
			...agentResult.responseMessages,
			{ role: 'user', content: TestAgentService._buildVerificationPrompt(expectedColumns) },
		];

		const schema = TestAgentService._buildVerificationSchema(expectedColumns);
		const result = await generateText({
			...modelConfig,
			output: Output.object({ schema }),
			messages,
			experimental_telemetry: llmTelemetry('nao-test-verification', { projectId }),
		});

		const { queryId, columns, data } = result.output;
		const queryRows = queryId
			? TestAgentService.resolveQueryRows(agentResult, { queryId, columns }, expectedColumns)
			: null;

		return { data: queryRows ?? data ?? null };
	}

	/**
	 * Read the complete rows of a query the agent ran, renamed to the expected columns.
	 * Returns null when the query id is unknown, so the caller can fall back.
	 */
	static resolveQueryRows(
		agentResult: AgentRunResult,
		selection: { queryId: string; columns: string[] | null },
		expectedColumns: string[],
	): VerificationData {
		const output = TestAgentService.extractToolCalls(agentResult)
			.filter((call) => call.toolName === 'execute_sql')
			.map((call) => call.result as executeSql.Output | undefined)
			.filter((result) => result?.id === selection.queryId)
			.at(-1);

		if (!output?.data) {
			return null;
		}

		const sourceColumns =
			selection.columns?.length === expectedColumns.length ? selection.columns : expectedColumns;

		return output.data.map((row) =>
			Object.fromEntries(expectedColumns.map((column, index) => [column, row[sourceColumns[index]] ?? null])),
		);
	}

	private static _buildUserMessage(text: string): UIMessage {
		return {
			id: crypto.randomUUID(),
			role: 'user',
			parts: [{ type: 'text', text }],
		};
	}

	private static _buildVerificationPrompt(columns: string[]): string {
		return `Based on your previous analysis, provide the final answer to the original question.

The answer has these columns: ${columns.join(', ')}

If one execute_sql result already holds the final answer, set queryId to its Query ID and set columns to that result's column names matching the ones above, in the same order. Leave data null: the full rows are read from the query itself, so never retype them.

Only when no single query result holds the answer, set queryId to null and return the rows in data.

If you cannot answer, set every field to null.`;
	}

	private static _buildVerificationSchema(columns: string[]) {
		const valueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
		const rowSchema = z.object(
			Object.fromEntries(columns.map((col) => [col, valueSchema.describe(`Value for column ${col}`)])),
		);

		return z.object({
			queryId: z
				.nullable(z.string())
				.describe('Query ID of the execute_sql result holding the answer. Null if no single query holds it.'),
			columns: z
				.nullable(z.array(z.string()))
				.describe(`Columns of that query result matching, in order: ${columns.join(', ')}`),
			data: z
				.nullable(z.array(rowSchema))
				.describe('Array of rows with the data. Only fill this when queryId is null.'),
		});
	}

	/**
	 * Extract tool calls from agent result steps.
	 * Collects all tool calls and their results from every step.
	 */
	static extractToolCalls(result: AgentRunResult): ToolCallResult[] {
		const resultByCallId = new Map<string, unknown>();
		const toolCalls: ToolCallResult[] = [];

		for (const step of result.steps) {
			for (const tr of step.toolResults) {
				resultByCallId.set(tr.toolCallId, tr.output);
			}
			for (const tc of step.toolCalls) {
				toolCalls.push({
					toolName: tc.toolName,
					toolCallId: tc.toolCallId,
					args: tc.input as Record<string, unknown>,
					result: resultByCallId.get(tc.toolCallId),
				});
			}
		}

		return toolCalls;
	}
}

// Singleton instance of the test agent service
export const testAgentService = new TestAgentService();
