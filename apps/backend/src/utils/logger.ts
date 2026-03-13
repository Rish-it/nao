import * as logQueries from '../queries/log.queries';
import type { LogLevel, LogSource } from '../types/log';
import { scheduleTask } from './schedule-task';

interface LogOptions {
	source: LogSource;
	projectId?: string;
	context?: Record<string, unknown>;
}

function writeLog(level: LogLevel, message: string, opts: LogOptions): void {
	const prefix = `[${level.toUpperCase()}] [${opts.source}]`;
	const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
	consoleFn(`${prefix} ${message}`);

	scheduleTask(() =>
		logQueries.insertLog({
			level,
			message,
			source: opts.source,
			projectId: opts.projectId,
			context: opts.context,
		}),
	);
}

export const logger = {
	error: (message: string, opts: LogOptions) => writeLog('error', message, opts),
	warn: (message: string, opts: LogOptions) => writeLog('warn', message, opts),
	info: (message: string, opts: LogOptions) => writeLog('info', message, opts),
	debug: (message: string, opts: LogOptions) => writeLog('debug', message, opts),
};
