import { exec as execCallback } from "child_process";
import { promisify } from "util";
import { v4 as uuidv4 } from 'uuid';

const exec = promisify(execCallback);

// Basic interfaces for tmux objects
export interface TmuxSession {
  id: string;
  name: string;
  attached: boolean;
  windows: number;
}

export interface TmuxWindow {
  id: string;
  name: string;
  active: boolean;
  sessionId: string;
}

export interface TmuxPane {
  id: string;
  windowId: string;
  active: boolean;
  title: string;
}

interface CommandExecution {
  id: string;
  paneId: string;
  command: string;
  status: 'pending' | 'completed' | 'error';
  startTime: Date;
  result?: string;
  exitCode?: number;
}

export type ShellType = 'bash' | 'zsh' | 'fish';

let shellConfig: { type: ShellType } = { type: 'bash' };

export function setShellConfig(config: { type: string }): void {
  // Validate shell type
  const validShells: ShellType[] = ['bash', 'zsh', 'fish'];

  if (validShells.includes(config.type as ShellType)) {
    shellConfig = { type: config.type as ShellType };
  } else {
    shellConfig = { type: 'bash' };
  }
}

/**
 * Execute a tmux command and return the result
 */
export async function executeTmux(tmuxCommand: string): Promise<string> {
  try {
    const { stdout } = await exec(`tmux ${tmuxCommand}`);
    return stdout.trim();
  } catch (error: any) {
    // Check if it's a tmux server not running error
    if (error.message.includes('no server running') || 
        error.message.includes('failed to connect to server') ||
        error.message.includes('connection refused')) {
      throw new Error(`Tmux server not available: ${error.message}`);
    }
    throw new Error(`Failed to execute tmux command: ${error.message}`);
  }
}

/**
 * Check if tmux server is running
 */
export async function isTmuxRunning(): Promise<boolean> {
  try {
    await executeTmux("list-sessions -F '#{session_name}'");
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * List all tmux sessions
 */
export async function listSessions(): Promise<TmuxSession[]> {
  try {
    const format = "#{session_id}:#{session_name}:#{?session_attached,1,0}:#{session_windows}";
    const output = await executeTmux(`list-sessions -F '${format}'`);

    if (!output) return [];

    return output.split('\n').map(line => {
      const [id, name, attached, windows] = line.split(':');
      return {
        id,
        name,
        attached: attached === '1',
        windows: parseInt(windows, 10)
      };
    });
  } catch (error: any) {
    // If tmux is not available, return empty array instead of throwing
    if (error.message.includes('Tmux server not available')) {
      return [];
    }
    throw error;
  }
}

/**
 * Find a session by name
 */
export async function findSessionByName(name: string): Promise<TmuxSession | null> {
  try {
    const sessions = await listSessions();
    return sessions.find(session => session.name === name) || null;
  } catch (error) {
    return null;
  }
}

/**
 * List windows in a session
 */
export async function listWindows(sessionId: string): Promise<TmuxWindow[]> {
  try {
    const format = "#{window_id}:#{window_name}:#{?window_active,1,0}";
    const output = await executeTmux(`list-windows -t '${sessionId}' -F '${format}'`);

    if (!output) return [];

    return output.split('\n').map(line => {
      const [id, name, active] = line.split(':');
      return {
        id,
        name,
        active: active === '1',
        sessionId
      };
    });
  } catch (error: any) {
    // If tmux is not available, return empty array instead of throwing
    if (error.message.includes('Tmux server not available')) {
      return [];
    }
    throw error;
  }
}

/**
 * List panes in a window
 */
export async function listPanes(windowId: string): Promise<TmuxPane[]> {
  try {
    const format = "#{pane_id}:#{pane_title}:#{?pane_active,1,0}";
    const output = await executeTmux(`list-panes -t '${windowId}' -F '${format}'`);

    if (!output) return [];

    return output.split('\n').map(line => {
      const [id, title, active] = line.split(':');
      return {
        id,
        windowId,
        title: title,
        active: active === '1'
      };
    });
  } catch (error: any) {
    // If tmux is not available, return empty array instead of throwing
    if (error.message.includes('Tmux server not available')) {
      return [];
    }
    throw error;
  }
}

/**
 * Capture content from a specific pane, by default the latest 200 lines.
 */
export async function capturePaneContent(paneId: string, lines: number = 200): Promise<string> {
  try {
    return await executeTmux(`capture-pane -p -t '${paneId}' -S -${lines} -E -`);
  } catch (error: any) {
    // If tmux is not available, return informative message instead of throwing
    if (error.message.includes('Tmux server not available')) {
      return 'Tmux server is not available. Cannot capture pane content.';
    }
    throw error;
  }
}

/**
 * Create a new tmux session
 */
export async function createSession(name: string): Promise<TmuxSession | null> {
  await executeTmux(`new-session -d -s "${name}"`);
  return findSessionByName(name);
}

/**
 * Create a new window in a session
 */
export async function createWindow(sessionId: string, name: string): Promise<TmuxWindow | null> {
  const output = await executeTmux(`new-window -t '${sessionId}' -n '${name}'`);
  const windows = await listWindows(sessionId);
  return windows.find(window => window.name === name) || null;
}

// Map to track ongoing command executions
const activeCommands = new Map<string, CommandExecution>();

const startMarkerText = 'TMUX_MCP_START';
const endMarkerPrefix = "TMUX_MCP_DONE_";

/**
 * Convert control characters and special keys to tmux key notation
 */
function convertToTmuxKeys(input: string): string[] {
  const keys: string[] = [];
  let i = 0;
  
  while (i < input.length) {
    const char = input[i];
    const nextChar = input[i + 1];
    
    // Handle Ctrl+ combinations (^C, ^D, etc.)
    if (char === '^' && nextChar) {
      const ctrlChar = nextChar.toUpperCase();
      keys.push(`C-${ctrlChar.toLowerCase()}`);
      i += 2;
      continue;
    }
    
    // Handle common control sequences
    switch (char) {
      case '\x03': // Ctrl+C
        keys.push('C-c');
        break;
      case '\x04': // Ctrl+D
        keys.push('C-d');
        break;
      case '\x1a': // Ctrl+Z
        keys.push('C-z');
        break;
      case '\x12': // Ctrl+R
        keys.push('C-r');
        break;
      case '\x0c': // Ctrl+L
        keys.push('C-l');
        break;
      case '\x15': // Ctrl+U
        keys.push('C-u');
        break;
      case '\x0b': // Ctrl+K
        keys.push('C-k');
        break;
      case '\x01': // Ctrl+A
        keys.push('C-a');
        break;
      case '\x05': // Ctrl+E
        keys.push('C-e');
        break;
      case '\x08': // Backspace
        keys.push('BSpace');
        break;
      case '\x7f': // Delete
        keys.push('Delete');
        break;
      case '\x1b': // Escape
        keys.push('Escape');
        break;
      case '\t': // Tab
        keys.push('Tab');
        break;
      case '\n': // Enter
        keys.push('Enter');
        break;
      case '\r': // Carriage return
        keys.push('Enter');
        break;
      default:
        // Regular character - escape single quotes for tmux
        if (char === "'") {
          keys.push("\"'\"");
        } else {
          keys.push(char);
        }
        break;
    }
    i++;
  }
  
  return keys;
}

// Execute a command in a tmux pane and track its execution
export async function executeCommand(paneId: string, command: string): Promise<string> {
  // Generate unique ID for this command execution
  const commandId = uuidv4();

  // Store command in tracking map with initial capture of pane content
  const initialContent = await capturePaneContent(paneId, 50);
  
  activeCommands.set(commandId, {
    id: commandId,
    paneId,
    command,
    status: 'pending',
    startTime: new Date(),
    result: initialContent // Store initial state for comparison
  });

  // Convert command to proper tmux key notation
  const tmuxKeys = convertToTmuxKeys(command);
  
  // Send each key/sequence individually for proper handling
  for (const key of tmuxKeys) {
    await executeTmux(`send-keys -t '${paneId}' ${key}`);
  }
  
  // Send Enter to execute (unless the command already ended with Enter)
  if (!command.endsWith('\n') && !command.endsWith('\r')) {
    await executeTmux(`send-keys -t '${paneId}' Enter`);
  }

  return commandId;
}

/**
 * Send raw keys/control characters to a tmux pane without tracking
 * This is useful for sending Ctrl+C, arrow keys, etc. to interactive applications
 */
export async function sendRawKeys(paneId: string, keys: string): Promise<void> {
  // Convert the input to tmux key notation
  const tmuxKeys = convertToTmuxKeys(keys);
  
  // Send each key/sequence individually
  for (const key of tmuxKeys) {
    await executeTmux(`send-keys -t '${paneId}' ${key}`);
  }
}

export async function checkCommandStatus(commandId: string): Promise<CommandExecution | null> {
  const command = activeCommands.get(commandId);
  if (!command) return null;

  if (command.status !== 'pending') return command;

  try {
    // Get current pane content
    const currentContent = await capturePaneContent(command.paneId, 1000);
    
    // Simple heuristic: if content has changed significantly and there's a new prompt,
    // assume the command has completed
    const initialContent = command.result || '';
    
    // Check if we have a shell prompt at the end (indicating command completion)
    // This is a simple heuristic - look for common prompt patterns
    const promptPatterns = [
      /\$\s*$/,           // bash/zsh prompt ending with $
      />\s*$/,            // fish prompt ending with >
      /#\s*$/,            // root prompt ending with #
      /\%\s*$/,           // zsh prompt ending with %
    ];
    
    const hasPrompt = promptPatterns.some(pattern => pattern.test(currentContent));
    const contentChanged = currentContent !== initialContent;
    
    // If content changed and we see a prompt, consider command completed
    if (contentChanged && hasPrompt) {
      // Check if enough time has passed (at least 500ms) to avoid false positives
      const timeSinceStart = Date.now() - command.startTime.getTime();
      if (timeSinceStart > 500) {
        command.status = 'completed';
        command.exitCode = 0; // We can't reliably determine exit code without markers
        command.result = currentContent;
        
        // Update in map
        activeCommands.set(commandId, command);
      }
    }
  } catch (error) {
    // If we can't check the pane, assume command is still running
    return command;
  }

  return command;
}

// Get command by ID
export function getCommand(commandId: string): CommandExecution | null {
  return activeCommands.get(commandId) || null;
}

// Get all active command IDs
export function getActiveCommandIds(): string[] {
  return Array.from(activeCommands.keys());
}

// Clean up completed commands older than a certain time
export function cleanupOldCommands(maxAgeMinutes: number = 60): void {
  const now = new Date();

  for (const [id, command] of activeCommands.entries()) {
    const ageMinutes = (now.getTime() - command.startTime.getTime()) / (1000 * 60);

    if (command.status !== 'pending' && ageMinutes > maxAgeMinutes) {
      activeCommands.delete(id);
    }
  }
}

function getEndMarkerText(): string {
  return shellConfig.type === 'fish'
    ? `${endMarkerPrefix}$status`
    : `${endMarkerPrefix}$?`;
}

