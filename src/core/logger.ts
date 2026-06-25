import * as vscode from 'vscode';

export class Logger implements vscode.Disposable {
	private readonly channel = vscode.window.createOutputChannel('At Mention Bridge', { log: true });

	info(message: string, ...args: unknown[]): void {
		this.channel.info(format(message, args));
	}

	warn(message: string, ...args: unknown[]): void {
		this.channel.warn(format(message, args));
	}

	error(message: string, error?: unknown): void {
		const details = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error ?? '');
		this.channel.error(details ? `${message}: ${details}` : message);
	}

	show(): void {
		this.channel.show();
	}

	dispose(): void {
		this.channel.dispose();
	}
}

function format(message: string, args: unknown[]): string {
	if (args.length === 0) {
		return message;
	}
	return `${message} ${args.map(formatArg).join(' ')}`;
}

function formatArg(arg: unknown): string {
	if (arg instanceof Error) {
		return `${arg.message}\n${arg.stack ?? ''}`;
	}
	if (typeof arg === 'string') {
		return arg;
	}
	return JSON.stringify(arg);
}
