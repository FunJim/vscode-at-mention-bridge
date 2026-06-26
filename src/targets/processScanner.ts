import { execFile } from 'child_process';
import { promisify } from 'util';
import { AgentDefinition, detectAgentFromCommand } from '../core/agents';
import { LogSink } from '../core/logger';

const execFileAsync = promisify(execFile);

export interface ProcessAgentMatch {
	readonly agent: AgentDefinition;
	readonly pid?: number;
	readonly commandLine: string;
	readonly tmuxPaneId?: string;
	readonly tmuxPanePid?: number;
	readonly tmuxClient?: string;
	readonly tmuxSessionName?: string;
	readonly tmuxWindowId?: string;
	readonly tmuxWindowIndex?: string;
	readonly tmuxWindowName?: string;
	readonly tmuxPaneIndex?: string;
	readonly tmuxIsActivePane?: boolean;
}

export interface TmuxPaneTarget {
	readonly tmuxPaneId: string;
	readonly tmuxPanePid?: number;
	readonly tmuxClient?: string;
	readonly tmuxSessionName?: string;
	readonly tmuxWindowId?: string;
	readonly tmuxWindowIndex?: string;
	readonly tmuxWindowName?: string;
	readonly tmuxPaneIndex?: string;
	readonly tmuxIsActivePane?: boolean;
}

export interface ProcessRow {
	readonly pid: number;
	readonly ppid: number;
	readonly command: string;
	readonly commandLine: string;
}

export interface ProcessScannerHost {
	listProcesses(): Promise<ProcessRow[]>;
	listTmuxClients(): Promise<string>;
	listTmuxPanes(): Promise<string>;
}

export interface ProcessScanSummary {
	readonly rootPid: number;
	readonly processCount: number;
	readonly descendantCount: number;
	readonly scannedProcessCount: number;
	readonly directMatchCount: number;
	readonly tmuxDetected: boolean;
	readonly tmuxMatchCount: number;
	readonly totalMatchCount: number;
}

interface TmuxClient {
	readonly name: string;
	readonly tty: string;
	readonly pid?: number;
	readonly sessionName: string;
	readonly paneId: string;
	readonly isControlMode: boolean;
}

interface TmuxPane {
	readonly sessionName: string;
	readonly windowId: string;
	readonly windowIndex: string;
	readonly windowName: string;
	readonly paneId: string;
	readonly paneIndex: string;
	readonly panePid?: number;
	readonly currentCommand: string;
	readonly title: string;
}

export class ProcessScanner {
	constructor(
		private readonly host: ProcessScannerHost = defaultProcessScannerHost,
		private readonly logger?: Pick<LogSink, 'debug' | 'warn'>,
	) {}

	async findAgentProcesses(rootPid: number): Promise<ProcessAgentMatch[]> {
		const rows = await this.host.listProcesses();
		const root = rows.find(row => row.pid === rootPid);
		const descendants = collectDescendants(rootPid, rows);
		const searchRows = [
			...(root ? [root] : []),
			...descendants,
		];
		const matches = new Map<string, ProcessAgentMatch>();
		let directMatchCount = 0;

		for (const row of searchRows) {
			const agent = detectAgentFromCommand(`${row.command} ${row.commandLine}`);
			if (agent) {
				directMatchCount++;
				matches.set(`${agent.id}:${row.pid}`, {
					agent,
					pid: row.pid,
					commandLine: row.commandLine || row.command,
				});
			}
		}

		const tmuxDetected = searchRows.some(row => /\btmux(?:\.exe)?\b/i.test(`${row.command} ${row.commandLine}`));
		let tmuxMatchCount = 0;
		if (tmuxDetected) {
			const tmuxMatches = await listTmuxAgentPanes(this.host, rootPid, rows, descendants, this.logger);
			tmuxMatchCount = tmuxMatches.length;
			for (const match of tmuxMatches) {
				matches.set(`${match.agent.id}:tmux:${match.tmuxPaneId}`, match);
			}
		}

		this.logger?.debug('Process scan completed', {
			rootPid,
			processCount: rows.length,
			descendantCount: descendants.length,
			scannedProcessCount: searchRows.length,
			directMatchCount,
			tmuxDetected,
			tmuxMatchCount,
			totalMatchCount: matches.size,
		} satisfies ProcessScanSummary);
		return [...matches.values()];
	}

	async processExists(pid: number): Promise<boolean> {
		const rows = await this.host.listProcesses();
		return rows.some(row => row.pid === pid);
	}

	async findExistingPids(pids: readonly number[]): Promise<Set<number>> {
		const wanted = new Set(pids);
		const rows = await this.host.listProcesses();
		return new Set(rows.filter(row => wanted.has(row.pid)).map(row => row.pid));
	}
}

const defaultProcessScannerHost: ProcessScannerHost = {
	listProcesses,
	async listTmuxClients() {
		const { stdout } = await execFileAsync('tmux', ['list-clients', '-F', '#{client_name}\t#{client_tty}\t#{client_pid}\t#{client_session}\t#{pane_id}\t#{client_control_mode}']);
		return stdout;
	},
	async listTmuxPanes() {
		const format = '#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_index}\t#{pane_pid}\t#{pane_current_command}\t#{pane_title}';
		const { stdout } = await execFileAsync('tmux', ['list-panes', '-a', '-F', format]);
		return stdout;
	},
};

export async function revealTmuxPane(target: TmuxPaneTarget): Promise<void> {
	const args = target.tmuxClient
		? ['switch-client', '-c', target.tmuxClient, '-t', target.tmuxPaneId]
		: ['switch-client', '-t', target.tmuxPaneId];
	await execFileAsync('tmux', args);
	await execFileAsync('tmux', ['select-pane', '-t', target.tmuxPaneId]);
}

export async function sendTextToTmuxPane(target: TmuxPaneTarget, text: string): Promise<void> {
	await execFileAsync('tmux', ['send-keys', '-t', target.tmuxPaneId, '-l', text]);
}

async function listProcesses(): Promise<ProcessRow[]> {
	if (process.platform === 'win32') {
		return listWindowsProcesses();
	}

	const args = process.platform === 'darwin'
		? ['-axo', 'pid=,ppid=,comm=,args=']
		: ['-eo', 'pid=,ppid=,comm=,args='];
	const { stdout } = await execFileAsync('ps', args, { maxBuffer: 1024 * 1024 * 5 });
	return stdout.split(/\r?\n/).flatMap(parseUnixProcessLine);
}

async function listWindowsProcesses(): Promise<ProcessRow[]> {
	const command = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
	const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], { maxBuffer: 1024 * 1024 * 5 });
	const parsed = JSON.parse(stdout || '[]') as unknown;
	const rows = Array.isArray(parsed) ? parsed : [parsed];
	return rows.flatMap(row => {
		if (!isWindowsProcessRow(row)) {
			return [];
		}
		return [{
			pid: row.ProcessId,
			ppid: row.ParentProcessId,
			command: row.Name ?? '',
			commandLine: row.CommandLine ?? row.Name ?? '',
		}];
	});
}

async function listTmuxAgentPanes(
	host: ProcessScannerHost,
	rootPid: number,
	rows: readonly ProcessRow[],
	descendants: readonly ProcessRow[],
	logger: Pick<LogSink, 'debug' | 'warn'> | undefined,
): Promise<ProcessAgentMatch[]> {
	try {
		const clients = await listTmuxClients(host, rootPid, descendants);
		const sessions = new Set(clients.map(client => client.sessionName).filter(Boolean));
		const panes = await listTmuxPanes(host);
		const matches = panes.flatMap(pane => {
			if (sessions.size > 0 && !sessions.has(pane.sessionName)) {
				return [];
			}
			const processMatch = pane.panePid ? findAgentInPane(pane.panePid, rows) : undefined;
			const commandLine = processMatch?.commandLine ?? `${pane.currentCommand} ${pane.title}`.trim();
			const agent = processMatch?.agent ?? detectAgentFromCommand(commandLine);
			if (!agent) {
				return [];
			}
			const client = clientForPane(pane, clients);
			return [{
				agent,
				pid: processMatch?.pid ?? pane.panePid,
				commandLine,
				tmuxPaneId: pane.paneId,
				tmuxPanePid: pane.panePid,
				tmuxClient: client ? targetForTmuxClient(client) : undefined,
				tmuxSessionName: pane.sessionName,
				tmuxWindowId: pane.windowId,
				tmuxWindowIndex: pane.windowIndex,
				tmuxWindowName: pane.windowName,
				tmuxPaneIndex: pane.paneIndex,
				tmuxIsActivePane: client?.paneId === pane.paneId,
			}];
		});
		logger?.debug('tmux scan completed', {
			rootPid,
			clientCount: clients.length,
			sessionCount: sessions.size,
			paneCount: panes.length,
			matchCount: matches.length,
		});
		return matches;
	} catch (error) {
		if (isExpectedTmuxProbeFailure(error)) {
			logger?.debug('tmux scan skipped because tmux is not ready for this terminal', {
				rootPid,
				reason: errorMessage(error),
			});
		} else {
			logger?.warn('Unable to scan tmux panes for agent processes', error);
		}
		return [];
	}
}

async function listTmuxClients(host: ProcessScannerHost, rootPid: number, descendants: readonly ProcessRow[]): Promise<TmuxClient[]> {
	const descendantPids = new Set([rootPid, ...descendants.map(row => row.pid)]);
	const stdout = await host.listTmuxClients();
	const clients = stdout.split(/\r?\n/).flatMap(line => {
		const [name, tty, pid, sessionName, paneId, controlMode] = line.split('\t');
		if (!sessionName) {
			return [];
		}
		return [{
			name: name ?? '',
			tty: tty ?? '',
			pid: Number(pid) || undefined,
			sessionName,
			paneId: paneId ?? '',
			isControlMode: controlMode === '1',
		}];
	});
	const matchedClients = clients.filter(client => client.pid && descendantPids.has(client.pid));
	if (matchedClients.length === 0) {
		return clients;
	}
	const matchedSessions = new Set(matchedClients.map(client => client.sessionName));
	return clients.filter(client => matchedSessions.has(client.sessionName));
}

async function listTmuxPanes(host: ProcessScannerHost): Promise<TmuxPane[]> {
	const stdout = await host.listTmuxPanes();
	return stdout.split(/\r?\n/).flatMap(line => {
		const [sessionName, windowId, windowIndex, windowName, paneId, paneIndex, panePid, currentCommand, title] = line.split('\t');
		if (!sessionName || !paneId) {
			return [];
		}
		return [{
			sessionName,
			windowId: windowId ?? '',
			windowIndex: windowIndex ?? '',
			windowName: windowName ?? '',
			paneId,
			paneIndex: paneIndex ?? '',
			panePid: Number(panePid) || undefined,
			currentCommand: currentCommand ?? '',
			title: title ?? '',
		}];
	});
}

function findAgentInPane(panePid: number, rows: readonly ProcessRow[]): ProcessAgentMatch | undefined {
	const paneRoot = rows.find(row => row.pid === panePid);
	const paneRows = [
		...(paneRoot ? [paneRoot] : []),
		...collectDescendants(panePid, rows),
	];
	for (const row of paneRows) {
		const commandLine = `${row.command} ${row.commandLine}`.trim();
		const agent = detectAgentFromCommand(commandLine);
		if (agent) {
			return {
				agent,
				pid: row.pid,
				commandLine: row.commandLine || row.command,
			};
		}
	}
	return undefined;
}

function clientForPane(pane: TmuxPane, clients: readonly TmuxClient[]): TmuxClient | undefined {
	return preferredTmuxClient(clients.filter(client => client.sessionName === pane.sessionName && client.paneId === pane.paneId))
		?? preferredTmuxClient(clients.filter(client => client.sessionName === pane.sessionName));
}

function targetForTmuxClient(client: TmuxClient): string | undefined {
	return client.name || client.tty || undefined;
}

function preferredTmuxClient(clients: readonly TmuxClient[]): TmuxClient | undefined {
	return [...clients].sort((first, second) => Number(first.isControlMode) - Number(second.isControlMode))[0];
}

function isExpectedTmuxProbeFailure(error: unknown): boolean {
	const message = errorMessage(error);
	return /\bno server running\b/i.test(message)
		|| /\bno current target\b/i.test(message);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function collectDescendants(rootPid: number, rows: readonly ProcessRow[]): ProcessRow[] {
	const childrenByParent = new Map<number, ProcessRow[]>();
	for (const row of rows) {
		const existing = childrenByParent.get(row.ppid) ?? [];
		existing.push(row);
		childrenByParent.set(row.ppid, existing);
	}

	const descendants: ProcessRow[] = [];
	const queue = [...(childrenByParent.get(rootPid) ?? [])];
	while (queue.length > 0) {
		const row = queue.shift();
		if (!row) {
			continue;
		}
		descendants.push(row);
		queue.push(...(childrenByParent.get(row.pid) ?? []));
	}
	return descendants;
}

function parseUnixProcessLine(line: string): ProcessRow[] {
	const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
	if (!match) {
		return [];
	}
	return [{
		pid: Number(match[1]),
		ppid: Number(match[2]),
		command: match[3],
		commandLine: match[4] ?? '',
	}];
}

function isWindowsProcessRow(row: unknown): row is {
	ProcessId: number;
	ParentProcessId: number;
	Name?: string;
	CommandLine?: string;
} {
	return typeof row === 'object'
		&& row !== null
		&& typeof (row as { ProcessId?: unknown }).ProcessId === 'number'
		&& typeof (row as { ParentProcessId?: unknown }).ParentProcessId === 'number';
}
