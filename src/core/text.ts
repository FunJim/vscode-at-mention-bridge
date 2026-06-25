export function truncateMiddle(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}
	if (maxLength <= 3) {
		return value.slice(0, maxLength);
	}

	const marker = '...';
	const available = maxLength - marker.length;
	const prefixLength = Math.ceil(available / 2);
	const suffixLength = Math.floor(available / 2);
	return `${value.slice(0, prefixLength)}${marker}${value.slice(value.length - suffixLength)}`;
}
