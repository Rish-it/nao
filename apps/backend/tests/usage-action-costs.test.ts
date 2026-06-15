import '../src/env';

import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as sqliteSchema from '../src/db/sqlite-schema';
import { chat, chatMessage, llmInference, organization, project, user } from '../src/db/sqlite-schema';
import { formatDate } from '../src/utils/date';

const db = drizzle('./db.sqlite', { schema: sqliteSchema });
vi.doMock('../src/db/db', () => ({ db }));

const { getMessagesUsage, getUsedProviders } = await import('../src/queries/usage.queries');

const ORG_ID = 'usage-actions-org';
const USER_ID = 'usage-actions-user';
const PROJECT_ID = 'usage-actions-project';
const CHAT_ID = 'usage-actions-chat';
const MESSAGE_ID = 'usage-actions-message';
const INFERENCE_IDS = [
	'usage-actions-chat',
	'usage-actions-title',
	'usage-actions-compaction',
	'usage-actions-test',
	'usage-actions-memory',
	'usage-actions-voice',
	'usage-actions-anthropic',
];

async function cleanup() {
	await db.delete(llmInference).where(inArray(llmInference.id, INFERENCE_IDS));
	await db.delete(chatMessage).where(eq(chatMessage.id, MESSAGE_ID));
	await db.delete(chat).where(eq(chat.id, CHAT_ID));
	await db.delete(project).where(eq(project.id, PROJECT_ID));
	await db.delete(organization).where(eq(organization.id, ORG_ID));
	await db.delete(user).where(eq(user.id, USER_ID));
}

async function seedProject(createdAt = new Date()) {
	await db.insert(organization).values({ id: ORG_ID, name: 'Usage Actions', slug: ORG_ID });
	await db.insert(user).values({ id: USER_ID, name: 'Usage User', email: 'usage-actions@example.com' });
	await db
		.insert(project)
		.values({ id: PROJECT_ID, orgId: ORG_ID, name: 'Usage Project', type: 'local', path: '/tmp/usage-actions' });
	await db
		.insert(chat)
		.values({ id: CHAT_ID, userId: USER_ID, projectId: PROJECT_ID, title: 'Usage chat', createdAt });
	await db.insert(chatMessage).values({ id: MESSAGE_ID, chatId: CHAT_ID, role: 'user', createdAt });
}

describe('usage action costs', () => {
	beforeEach(async () => {
		await cleanup();
	});

	afterEach(cleanup);

	afterAll(() => {
		db.$client.close();
	});

	it('surfaces LLM inference costs by action bucket', async () => {
		const createdAt = new Date();
		await seedProject(createdAt);
		await db.insert(llmInference).values([
			{
				id: 'usage-actions-chat',
				projectId: PROJECT_ID,
				userId: USER_ID,
				chatId: CHAT_ID,
				type: 'chat',
				llmProvider: 'openai',
				llmModelId: 'gpt-4.1',
				inputNoCacheTokens: 1_000_000,
				createdAt,
			},
			{
				id: 'usage-actions-title',
				projectId: PROJECT_ID,
				userId: USER_ID,
				chatId: CHAT_ID,
				type: 'title_generation',
				llmProvider: 'openai',
				llmModelId: 'gpt-4.1',
				outputTotalTokens: 1_000_000,
				createdAt,
			},
			{
				id: 'usage-actions-compaction',
				projectId: PROJECT_ID,
				userId: USER_ID,
				chatId: CHAT_ID,
				type: 'compaction',
				llmProvider: 'openai',
				llmModelId: 'gpt-4.1',
				outputTotalTokens: 1_000_000,
				createdAt,
			},
			{
				id: 'usage-actions-test',
				projectId: PROJECT_ID,
				userId: USER_ID,
				chatId: CHAT_ID,
				type: 'test',
				llmProvider: 'openai',
				llmModelId: 'gpt-4.1',
				inputNoCacheTokens: 1_000_000,
				createdAt,
			},
			{
				id: 'usage-actions-memory',
				projectId: PROJECT_ID,
				userId: USER_ID,
				chatId: CHAT_ID,
				type: 'memory_extraction',
				llmProvider: 'openai',
				llmModelId: 'gpt-4.1',
				inputNoCacheTokens: 1_000_000,
				createdAt,
			},
			{
				id: 'usage-actions-voice',
				projectId: PROJECT_ID,
				userId: USER_ID,
				chatId: CHAT_ID,
				type: 'voice',
				llmProvider: 'openai',
				llmModelId: 'gpt-4o-mini-transcribe',
				estimatedCost: 0.42,
				createdAt,
			},
		] as (typeof llmInference.$inferInsert)[]);

		const usage = await getMessagesUsage(PROJECT_ID, { granularity: 'day' });
		const row = usage.find((record) => record.date === formatDate(createdAt, 'day'));

		expect(row).toMatchObject({
			chatCost: 27,
			testCost: 3,
			memoryCost: 3,
			voiceCost: 0.42,
		});
	});

	it('includes providers that only appear in llm_inference records', async () => {
		const createdAt = new Date();
		await seedProject(createdAt);
		await db.insert(llmInference).values({
			id: 'usage-actions-anthropic',
			projectId: PROJECT_ID,
			userId: USER_ID,
			chatId: CHAT_ID,
			type: 'test',
			llmProvider: 'anthropic',
			llmModelId: 'claude-sonnet-4-20250514',
			inputNoCacheTokens: 1,
			createdAt,
		} as typeof llmInference.$inferInsert);

		await expect(getUsedProviders(PROJECT_ID)).resolves.toContain('anthropic');
	});
});
