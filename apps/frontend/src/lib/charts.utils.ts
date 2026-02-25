import { hashValue } from './hash';

export type RangeOptions = Record<string, { label: string }>;

// TODO: make this dynamic based on the data
export const DATE_RANGE_OPTIONS = {
	'7d': { label: 'Last 7 days' },
	'30d': { label: 'Last 30 days' },
	'3m': { label: 'Last 3 months' },
	'6m': { label: 'Last 6 months' },
	'1y': { label: 'Last year' },
	all: { label: 'All data' },
} satisfies RangeOptions;

export type DateRange = keyof typeof DATE_RANGE_OPTIONS;

/** Filters data by date range preset (relative to the first date in the data, assuming data is ordered) */
export function filterByDateRange<T extends Record<string, any>>(data: T[], xAxisKey: string, range: DateRange): T[] {
	if (range === 'all' || data.length === 0) {
		return data;
	}

	const latestDate = data.at(-1)?.[xAxisKey]; // Assuming data is ordered by date
	if (latestDate == null) {
		return data;
	}

	const cutoffDate = new Date(latestDate);
	if (!isValidDate(cutoffDate)) {
		return data;
	}

	switch (range) {
		case '7d':
			cutoffDate.setTime(cutoffDate.getTime() - 7 * 24 * 60 * 60 * 1000);
			break;
		case '30d':
			cutoffDate.setTime(cutoffDate.getTime() - 30 * 24 * 60 * 60 * 1000);
			break;
		case '3m':
			cutoffDate.setMonth(cutoffDate.getMonth() - 3);
			break;
		case '6m':
			cutoffDate.setMonth(cutoffDate.getMonth() - 6);
			break;
		case '1y':
			cutoffDate.setFullYear(cutoffDate.getFullYear() - 1);
			break;
		default:
			return data;
	}

	return data.filter((item) => {
		const dateValue = item[xAxisKey];
		const date = new Date(dateValue);
		if (!isValidDate(date)) {
			return false;
		}

		return date >= cutoffDate;
	});
}

function isValidDate(date: Date): boolean {
	return !isNaN(date.getTime());
}

/** Checks if a string is in ISO 8601 date format (e.g., 2024-01-15 or 2024-01-15T12:30:00Z) */
function isISODateString(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})?)?$/.test(value);
}

/** Converts a data key to a human readable label */
export const labelize = (key: any) => {
	if (typeof key === 'string' && isISODateString(key)) {
		const date = new Date(key);
		if (isValidDate(date)) {
			return date.toDateString();
		}
	}
	return String(key)
		.replace(/_/g, ' ')
		.replace(/\b\w/g, (char) => char.toUpperCase());
};

export const toKey = (value: string) => {
	return hashValue(value);
};

/** Downloads the chart inside the given container as a PNG file */
export async function downloadChartAsPng(container: HTMLElement, filename: string): Promise<void> {
	const chartElement = container.querySelector<HTMLElement>('[data-chart]');
	if (!chartElement) {
		return;
	}

	const svg = chartElement.querySelector('svg');
	if (!svg) {
		return;
	}

	const { width, height } = svg.getBoundingClientRect();
	const clone = svg.cloneNode(true) as SVGSVGElement;
	clone.setAttribute('width', String(width));
	clone.setAttribute('height', String(height));

	const svgString = resolveCssVariables(new XMLSerializer().serializeToString(clone), chartElement);
	const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
	const url = URL.createObjectURL(blob);

	try {
		await svgToPngDownload(url, width, height, filename);
	} finally {
		URL.revokeObjectURL(url);
	}
}

function resolveCssVariables(svgString: string, element: HTMLElement): string {
	const style = getComputedStyle(element);
	return svgString.replace(/var\(--([^)]+)\)/g, (original, varName) => {
		return style.getPropertyValue(`--${varName}`).trim() || original;
	});
}

function svgToPngDownload(svgUrl: string, width: number, height: number, filename: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => {
			const scale = 2;
			const canvas = document.createElement('canvas');
			canvas.width = width * scale;
			canvas.height = height * scale;

			const ctx = canvas.getContext('2d');
			if (!ctx) {
				reject(new Error('Failed to create canvas context'));
				return;
			}
			ctx.scale(scale, scale);
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, width, height);
			ctx.drawImage(img, 0, 0, width, height);

			const link = document.createElement('a');
			link.download = `${filename}.png`;
			link.href = canvas.toDataURL('image/png');
			link.click();
			resolve();
		};
		img.onerror = reject;
		img.src = svgUrl;
	});
}
