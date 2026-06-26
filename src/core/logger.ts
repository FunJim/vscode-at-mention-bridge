import * as vscode from 'vscode';

export interface LogSink {
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, error?: unknown): void;
}

export class Logger implements vscode.Disposable, LogSink {
	private readonly channel = vscode.window.createOutputChannel('At Mention Bridge', { log: true });

	debug(message: string, ...args: unknown[]): void {
		this.channel.debug(format(message, args));
	}

	info(message: string, ...args: unknown[]): void {
		this.channel.info(format(message, args));
	}

	warn(message: string, ...args: unknown[]): void {
		this.channel.warn(format(message, args, { includeErrorStack: false }));
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

function format(message: string, args: unknown[], options: { includeErrorStack?: boolean } = {}): string {
	if (args.length === 0) {
		return message;
	}
	return `${message} ${args.map(arg => formatArg(arg, options)).join(' ')}`;
}

function formatArg(arg: unknown, options: { includeErrorStack?: boolean }): string {
	if (arg instanceof Error) {
		if (options.includeErrorStack === false) {
			return arg.message;
		}
		return `${arg.message}\n${arg.stack ?? ''}`;
	}
	if (typeof arg === 'string') {
		return arg;
	}
	try {
		return JSON.stringify(arg);
	} catch {
		return String(arg);
	}
}
