import { and, eq, isNotNull, SQL, sql, SQLWrapper, sum } from 'drizzle-orm';

import { LLM_PROVIDERS } from '../agents/providers';
import s from '../db/abstractSchema';
import { db } from '../db/db';
import dbConfig, { Dialect } from '../db/dbConfig';
import type { LlmProvider } from '../types/llm';
import type { Granularity, UsageFilter, UsageRecord } from '../types/usage';
import { fillMissingDates, getLookbackTimestamp } from '../utils/date';

const COST_COLS = [
	'provider',
	'model_id',
	'input_no_cache',
	'input_cache_read',
	'input_cache_write',
	'output',
] as const;

const sqliteFormats = {
	hour: '%Y-%m-%d %H:00',
	day: '%Y-%m-%d',
	month: '%Y-%m',
};

const pgFormats = {
	hour: 'YYYY-MM-DD HH24:00',
	day: 'YYYY-MM-DD',
	month: 'YYYY-MM',
};

export const getMessagesUsage = async (projectId: string, filter: UsageFilter): Promise<UsageRecord[]> => {
	const { granularity, provider } = filter;
	const dateExpr = getDateExpr(s.chatMessage.createdAt, granularity);
	const lookbackFilter = getLookbackFilter(s.chatMessage.createdAt, granularity);

	const whereConditions = [eq(s.chat.projectId, projectId), lookbackFilter];
	if (provider) {
		whereConditions.push(eq(s.chatMessage.llmProvider, provider));
	}

	const costLookup = buildCostValuesTable();

	const rows = await db
		.select({
			date: dateExpr,
			messageCount: sql<number>`count(distinct case when ${s.chatMessage.role} = 'user' then ${s.chatMessage.id} end)`,
			webMessageCount: sql<number>`count(distinct case when ${s.chatMessage.role} = 'user' and ${s.chatMessage.source} = 'web' then ${s.chatMessage.id} end)`,
			slackMessageCount: sql<number>`count(distinct case when ${s.chatMessage.role} = 'user' and ${s.chatMessage.source} = 'slack' then ${s.chatMessage.id} end)`,
			teamsMessageCount: sql<number>`count(distinct case when ${s.chatMessage.role} = 'user' and ${s.chatMessage.source} = 'teams' then ${s.chatMessage.id} end)`,
			telegramMessageCount: sql<number>`count(distinct case when ${s.chatMessage.role} = 'user' and ${s.chatMessage.source} = 'telegram' then ${s.chatMessage.id} end)`,
			inputNoCacheTokens: sum(s.chatMessage.inputNoCacheTokens),
			inputCacheReadTokens: sum(s.chatMessage.inputCacheReadTokens),
			inputCacheWriteTokens: sum(s.chatMessage.inputCacheWriteTokens),
			outputTotalTokens: sum(s.chatMessage.outputTotalTokens),
			totalTokens: sum(s.chatMessage.totalTokens),
			inputNoCacheCost: sql<number>`sum(coalesce(${s.chatMessage.inputNoCacheTokens}, 0) * coalesce(cost_lookup.input_no_cache, 0) / 1000000.0)`,
			inputCacheReadCost: sql<number>`sum(coalesce(${s.chatMessage.inputCacheReadTokens}, 0) * coalesce(cost_lookup.input_cache_read, 0) / 1000000.0)`,
			inputCacheWriteCost: sql<number>`sum(coalesce(${s.chatMessage.inputCacheWriteTokens}, 0) * coalesce(cost_lookup.input_cache_write, 0) / 1000000.0)`,
			outputCost: sql<number>`sum(coalesce(${s.chatMessage.outputTotalTokens}, 0) * coalesce(cost_lookup.output, 0) / 1000000.0)`,
		})
		.from(s.chatMessage)
		.innerJoin(s.chat, eq(s.chatMessage.chatId, s.chat.id))
		.leftJoin(
			costLookup,
			sql`cost_lookup.provider = ${s.chatMessage.llmProvider} AND cost_lookup.model_id = ${s.chatMessage.llmModelId}`,
		)
		.where(and(...whereConditions))
		.groupBy(dateExpr);

	const actionCostsByDate = await getActionCostsByDate(projectId, filter);

	const messagesByDate = new Map(rows.map((row) => [row.date, row]));
	const allDates = new Set([...messagesByDate.keys(), ...actionCostsByDate.keys()]);

	const merged = [...allDates].map((date) => {
		const row = messagesByDate.get(date);
		const actionCosts = actionCostsByDate.get(date) ?? {
			chatCost: 0,
			testCost: 0,
			memoryCost: 0,
			voiceCost: 0,
		};
		return {
			...actionCosts,
			date,
			messageCount: row?.messageCount ?? 0,
			webMessageCount: row?.webMessageCount ?? 0,
			slackMessageCount: row?.slackMessageCount ?? 0,
			teamsMessageCount: row?.teamsMessageCount ?? 0,
			telegramMessageCount: row?.telegramMessageCount ?? 0,
			inputNoCacheTokens: Number(row?.inputNoCacheTokens ?? 0),
			inputCacheReadTokens: Number(row?.inputCacheReadTokens ?? 0),
			inputCacheWriteTokens: Number(row?.inputCacheWriteTokens ?? 0),
			outputTotalTokens: Number(row?.outputTotalTokens ?? 0),
			totalTokens: Number(row?.totalTokens ?? 0),
			inputNoCacheCost: Number(row?.inputNoCacheCost ?? 0),
			inputCacheReadCost: Number(row?.inputCacheReadCost ?? 0),
			inputCacheWriteCost: Number(row?.inputCacheWriteCost ?? 0),
			outputCost: Number(row?.outputCost ?? 0),
			totalCost:
				Number(row?.inputNoCacheCost ?? 0) +
				Number(row?.inputCacheReadCost ?? 0) +
				Number(row?.inputCacheWriteCost ?? 0) +
				Number(row?.outputCost ?? 0),
		};
	});

	return fillMissingDates(merged, granularity);
};

export const getUsedProviders = async (projectId: string): Promise<LlmProvider[]> => {
	const rows = await db
		.selectDistinct({ provider: s.chatMessage.llmProvider })
		.from(s.chatMessage)
		.innerJoin(s.chat, eq(s.chatMessage.chatId, s.chat.id))
		.where(and(eq(s.chat.projectId, projectId), isNotNull(s.chatMessage.llmProvider)))
		.execute();

	return rows.map((row) => row.provider).filter((p): p is LlmProvider => p !== null);
};

function getDateExpr(field: SQLWrapper, granularity: Granularity): SQL<string> {
	if (dbConfig.dialect === Dialect.Postgres) {
		const format = sql.raw(`'${pgFormats[granularity]}'`);
		return sql<string>`to_char(${field}, ${format})`;
	} else {
		const format = sql.raw(`'${sqliteFormats[granularity]}'`);
		return sql<string>`strftime(${format}, ${field} / 1000, 'unixepoch')`;
	}
}

function getLookbackFilter(field: SQLWrapper, granularity: Granularity): SQL {
	const lookbackTs = getLookbackTimestamp(granularity);
	return dbConfig.dialect === Dialect.Postgres
		? sql`${field} >= ${new Date(lookbackTs).toISOString()}`
		: sql`${field} >= ${lookbackTs}`;
}

async function getActionCostsByDate(
	projectId: string,
	filter: UsageFilter,
): Promise<Map<string, Pick<UsageRecord, 'chatCost' | 'testCost' | 'memoryCost' | 'voiceCost'>>> {
	const { granularity, provider } = filter;
	const dateExpr = getDateExpr(s.llmInference.createdAt, granularity);
	const lookbackFilter = getLookbackFilter(s.llmInference.createdAt, granularity);
	const whereConditions = [eq(s.llmInference.projectId, projectId), lookbackFilter];
	if (provider) {
		whereConditions.push(eq(s.llmInference.llmProvider, provider));
	}

	const costLookup = buildCostValuesTable();
	const rowCostExpr = sql<number>`
		(
			coalesce(${s.llmInference.inputNoCacheTokens}, 0) * coalesce(cost_lookup.input_no_cache, 0)
			+ coalesce(${s.llmInference.inputCacheReadTokens}, 0) * coalesce(cost_lookup.input_cache_read, 0)
			+ coalesce(${s.llmInference.inputCacheWriteTokens}, 0) * coalesce(cost_lookup.input_cache_write, 0)
			+ coalesce(${s.llmInference.outputTotalTokens}, 0) * coalesce(cost_lookup.output, 0)
		) / 1000000.0
	`;

	const rows = await db
		.select({
			date: dateExpr,
			chatCost: sql<number>`sum(case when ${s.llmInference.type} in ('chat', 'compaction', 'title_generation') then ${rowCostExpr} else 0 end)`,
			testCost: sql<number>`sum(case when ${s.llmInference.type} = 'test' then ${rowCostExpr} else 0 end)`,
			memoryCost: sql<number>`sum(case when ${s.llmInference.type} = 'memory_extraction' then ${rowCostExpr} else 0 end)`,
			voiceCost: sql<number>`sum(case when ${s.llmInference.type} = 'voice' then coalesce(${s.llmInference.estimatedCost}, 0) else 0 end)`,
		})
		.from(s.llmInference)
		.leftJoin(
			costLookup,
			sql`cost_lookup.provider = ${s.llmInference.llmProvider} AND cost_lookup.model_id = ${s.llmInference.llmModelId}`,
		)
		.where(and(...whereConditions))
		.groupBy(dateExpr);

	return new Map(
		rows.map((row) => [
			row.date,
			{
				chatCost: Number(row.chatCost ?? 0),
				testCost: Number(row.testCost ?? 0),
				memoryCost: Number(row.memoryCost ?? 0),
				voiceCost: Number(row.voiceCost ?? 0),
			},
		]),
	);
}

/** Build a SQL VALUES table with cost-per-million for each (provider, modelId) */
function buildCostValuesTable(): SQL {
	const tuples = Object.entries(LLM_PROVIDERS).flatMap(([provider, config]) =>
		config.models.map((model) => {
			const cost = model.costPerM ?? {};
			return [
				provider,
				model.id,
				cost.inputNoCache ?? 0,
				cost.inputCacheRead ?? 0,
				cost.inputCacheWrite ?? 0,
				cost.output ?? 0,
			] as const;
		}),
	);

	const toRow = (t: (typeof tuples)[0]) => `'${t[0]}', '${t[1]}', ${t[2]}, ${t[3]}, ${t[4]}, ${t[5]}`;

	if (dbConfig.dialect === Dialect.Postgres) {
		const rows = tuples.map((t) => `(${toRow(t)})`).join(', ');
		return sql.raw(`(VALUES ${rows}) AS cost_lookup(${COST_COLS.join(', ')})`);
	} else {
		const [first, ...rest] = tuples;
		const firstRow = `SELECT ${first.map((v, i) => `${typeof v === 'string' ? `'${v}'` : v} AS ${COST_COLS[i]}`).join(', ')}`;
		const restRows = rest.map((t) => `SELECT ${toRow(t)}`);
		return sql.raw(`(${[firstRow, ...restRows].join(' UNION ALL ')}) AS cost_lookup`);
	}
}
