import * as path from 'path';
import * as vscode from 'vscode';

export interface ReferenceLocation {
	readonly lineStart?: number;
	readonly lineEnd?: number;
}

export interface ReferenceContext extends ReferenceLocation {
	readonly uri: vscode.Uri;
	readonly relativePath: string;
	readonly absolutePath: string;
	readonly fileName: string;
	readonly locationSuffix: string;
	readonly isDirectory: boolean;
}

export function selectionToLocation(selection: vscode.Selection | undefined): ReferenceLocation {
	if (!selection || selection.isEmpty) {
		return {};
	}

	const start = Math.min(selection.start.line, selection.end.line) + 1;
	const endPosition = selection.end;
	const end = endPosition.character === 0 && endPosition.line > selection.start.line
		? endPosition.line
		: endPosition.line + 1;
	const lineEnd = Math.max(start, end);
	return {
		lineStart: start,
		lineEnd,
	};
}

export async function buildReferenceContext(uri: vscode.Uri, location: ReferenceLocation = {}): Promise<ReferenceContext> {
	if (uri.scheme !== 'file') {
		throw new Error(`Only file system resources are supported. Received ${uri.scheme}: ${uri.toString(true)}`);
	}

	const stat = await vscode.workspace.fs.stat(uri);
	const isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
	const absolutePath = withDirectorySlash(uri.fsPath, isDirectory);
	const relativePath = toRelativePath(uri, isDirectory);
	const fileName = path.basename(uri.fsPath) + (isDirectory ? '/' : '');
	const locationSuffix = location.lineStart
		? location.lineStart === location.lineEnd
			? `#${location.lineStart}`
			: `#${location.lineStart}-${location.lineEnd}`
		: '';

	return {
		uri,
		relativePath,
		absolutePath,
		fileName,
		locationSuffix,
		lineStart: location.lineStart,
		lineEnd: location.lineEnd,
		isDirectory,
	};
}

function toRelativePath(uri: vscode.Uri, isDirectory: boolean): string {
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	if (!folder) {
		return withDirectorySlash(uri.fsPath, isDirectory);
	}

	const relative = path.relative(folder.uri.fsPath, uri.fsPath);
	const normalized = relative.split(path.sep).join('/');
	return isDirectory ? `${normalized}/` : normalized;
}

function withDirectorySlash(fsPath: string, isDirectory: boolean): string {
	const normalized = fsPath.split(path.sep).join('/');
	return isDirectory && !normalized.endsWith('/') ? `${normalized}/` : normalized;
}
