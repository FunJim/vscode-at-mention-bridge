import type { ReferenceContext } from './references';

export function renderTemplate(template: string, context: ReferenceContext): string {
	const templateFunction = new Function(
		'relativePath',
		'absolutePath',
		'fileName',
		'locationSuffix',
		'lineStart',
		'lineEnd',
		'isDirectory',
		`return \`${template}\`;`,
	);

	return String(templateFunction(
		context.relativePath,
		context.absolutePath,
		context.fileName,
		context.locationSuffix,
		context.lineStart,
		context.lineEnd,
		context.isDirectory,
	));
}

export function validateTemplates(templates: Record<string, string>): string[] {
	return Object.entries(templates)
		.filter(([name, template]) => !name.trim() || typeof template !== 'string' || !template.trim())
		.map(([name]) => name);
}
