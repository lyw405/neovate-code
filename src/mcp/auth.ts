import createDebug from 'debug';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'pathe';

const debug = createDebug('neovate:mcp:auth');

/**
 * OAuth token information for MCP servers
 */
export interface McpTokenInfo {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
}

/**
 * OAuth client registration information
 */
export interface McpClientInfo {
  clientId: string;
  clientSecret?: string;
  registrationAccessToken?: string;
}

/**
 * Combined OAuth credentials
 */
export interface McpOAuthCredentials {
  token?: McpTokenInfo;
  client?: McpClientInfo;
}

/**
 * Storage for all MCP OAuth credentials
 */
interface McpAuthStorage {
  version: string;
  credentials: Record<string, McpOAuthCredentials>;
}

export class McpAuth {
  private static readonly AUTH_FILE_PATH = join(
    homedir(),
    '.local',
    'share',
    'neovate-code',
    'mcp-auth.json',
  );
  private static readonly CURRENT_VERSION = '1.0';
  private storage: McpAuthStorage;

  constructor() {
    this.storage = this.loadStorage();
  }

  /**
   * Get OAuth credentials for a specific MCP server
   */
  getCredentials(serverName: string): McpOAuthCredentials | undefined {
    return this.storage.credentials[serverName];
  }

  /**
   * Get token for a specific MCP server
   */
  getToken(serverName: string): McpTokenInfo | undefined {
    return this.storage.credentials[serverName]?.token;
  }

  /**
   * Get client info for a specific MCP server
   */
  getClient(serverName: string): McpClientInfo | undefined {
    return this.storage.credentials[serverName]?.client;
  }

  /**
   * Save token for a specific MCP server
   */
  saveToken(serverName: string, token: McpTokenInfo): void {
    if (!this.storage.credentials[serverName]) {
      this.storage.credentials[serverName] = {};
    }
    this.storage.credentials[serverName].token = token;
    this.saveStorage();
    debug(`Token saved for server: ${serverName}`);
  }

  /**
   * Save client info for a specific MCP server
   */
  saveClient(serverName: string, client: McpClientInfo): void {
    if (!this.storage.credentials[serverName]) {
      this.storage.credentials[serverName] = {};
    }
    this.storage.credentials[serverName].client = client;
    this.saveStorage();
    debug(`Client info saved for server: ${serverName}`);
  }

  /**
   * Save complete credentials for a specific MCP server
   */
  saveCredentials(serverName: string, credentials: McpOAuthCredentials): void {
    this.storage.credentials[serverName] = credentials;
    this.saveStorage();
    debug(`Credentials saved for server: ${serverName}`);
  }

  /**
   * Remove credentials for a specific MCP server
   */
  removeCredentials(serverName: string): void {
    delete this.storage.credentials[serverName];
    this.saveStorage();
    debug(`Credentials removed for server: ${serverName}`);
  }

  /**
   * Check if token is expired
   */
  isTokenExpired(serverName: string): boolean {
    const token = this.getToken(serverName);
    if (!token || !token.expiresAt) {
      return false;
    }
    return Date.now() >= token.expiresAt;
  }

  /**
   * Get all server names with credentials
   */
  getAllServerNames(): string[] {
    return Object.keys(this.storage.credentials);
  }

  /**
   * Load storage from disk
   */
  private loadStorage(): McpAuthStorage {
    try {
      if (existsSync(McpAuth.AUTH_FILE_PATH)) {
        const content = readFileSync(McpAuth.AUTH_FILE_PATH, 'utf-8');
        const data = JSON.parse(content) as McpAuthStorage;

        // Validate version
        if (data.version !== McpAuth.CURRENT_VERSION) {
          debug(`Auth storage version mismatch, creating new storage`);
          return this.createEmptyStorage();
        }

        debug(
          `Loaded auth storage with ${Object.keys(data.credentials).length} servers`,
        );
        return data;
      }
    } catch (error) {
      debug(`Error loading auth storage: ${error}`);
    }

    return this.createEmptyStorage();
  }

  /**
   * Save storage to disk
   */
  private saveStorage(): void {
    try {
      const dir = dirname(McpAuth.AUTH_FILE_PATH);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      const content = JSON.stringify(this.storage, null, 2);
      writeFileSync(McpAuth.AUTH_FILE_PATH, content, {
        encoding: 'utf-8',
        mode: 0o600, // Read/write for owner only
      });

      debug(`Auth storage saved to ${McpAuth.AUTH_FILE_PATH}`);
    } catch (error) {
      debug(`Error saving auth storage: ${error}`);
      throw new Error(`Failed to save OAuth credentials: ${error}`);
    }
  }

  /**
   * Create empty storage structure
   */
  private createEmptyStorage(): McpAuthStorage {
    return {
      version: McpAuth.CURRENT_VERSION,
      credentials: {},
    };
  }

  /**
   * Get the auth file path (for debugging/testing)
   */
  static getAuthFilePath(): string {
    return McpAuth.AUTH_FILE_PATH;
  }
}
