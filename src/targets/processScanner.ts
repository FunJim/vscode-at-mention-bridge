import { execFile } from 'child_process';
import { promisify } from 'util';
import { AgentDefinition, detectAgentFromCommand } from '../core/agents';

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

interface ProcessRow {
	readonly pid: number;
	readonly ppid: number;
	readonly command: string;
	readonly commandLine: string;
}

interface TmuxClient {
	readonly name: string;
	readonly tty: string;
	readonly pid?: number;
	readonly sessionName: string;
	readonly paneId: string;
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
	async findAgentProcesses(rootPid: number): Promise<ProcessAgentMatch[]> {
		const rows = await listProcesses();
		const descendants = collectDescendants(rootPid, rows);
		const matches = new Map<string, ProcessAgentMatch>();

		for (const row of descendants) {
			const agent = detectAgentFromCommand(`${row.command} ${row.commandLine}`);
			if (agent) {
				matches.set(`${agent.id}:${row.pid}`, {
					agent,
					pid: row.pid,
					commandLine: row.commandLine || row.command,
				});
			}
		}

		if (descendants.some(row => /\btmux(?:\.exe)?\b/i.test(`${row.command} ${row.commandLine}`))) {
			for (const match of await listTmuxAgentPanes(rootPid, rows, descendants)) {
				matches.set(`${match.agent.id}:tmux:${match.tmuxPaneId}`, match);
			}
		}

		return [...matches.values()];
	}

	async processExists(pid: number): Promise<boolean> {
		const rows = await listProcesses();
		return rows.some(row => row.pid === pid);
	}

	async findExistingPids(pids: readonly number[]): Promise<Set<number>> {
		const wanted = new Set(pids);
		const rows = await listProcesses();
		return new Set(rows.filter(row => wanted.has(row.pid)).map(row => row.pid));
	}
}

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

async function listTmuxAgentPanes(rootPid: number, rows: readonly ProcessRow[], descendants: readonly ProcessRow[]): Promise<ProcessAgentMatch[]> {
	try {
		const clients = await listTmuxClients(rootPid, descendants);
		const sessions = new Set(clients.map(client => client.sessionName).filter(Boolean));
		const panes = await listTmuxPanes();
		return panes.flatMap(pane => {
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
	} catch {
		return [];
	}
}

async function listTmuxClients(rootPid: number, descendants: readonly ProcessRow[]): Promise<TmuxClient[]> {
	const descendantPids = new Set([rootPid, ...descendants.map(row => row.pid)]);
	const { stdout } = await execFileAsync('tmux', ['list-clients', '-F', '#{client_name}\t#{client_tty}\t#{client_pid}\t#{client_session}\t#{pane_id}']);
	const clients = stdout.split(/\r?\n/).flatMap(line => {
		const [name, tty, pid, sessionName, paneId] = line.split('\t');
		if (!sessionName) {
			return [];
		}
		return [{
			name: name ?? '',
			tty: tty ?? '',
			pid: Number(pid) || undefined,
			sessionName,
			paneId: paneId ?? '',
		}];
	});
	const matchedClients = clients.filter(client => client.pid && descendantPids.has(client.pid));
	return matchedClients.length > 0 ? matchedClients : clients;
}

async function listTmuxPanes(): Promise<TmuxPane[]> {
	const format = '#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_index}\t#{pane_pid}\t#{pane_current_command}\t#{pane_title}';
	const { stdout } = await execFileAsync('tmux', ['list-panes', '-a', '-F', format]);
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
	return clients.find(client => client.sessionName === pane.sessionName && client.paneId === pane.paneId)
		?? clients.find(client => client.sessionName === pane.sessionName);
}

function targetForTmuxClient(client: TmuxClient): string | undefined {
	return client.name || client.tty || undefined;
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
