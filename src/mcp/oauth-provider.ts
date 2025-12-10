import createDebug from 'debug';
import type { McpAuth, McpClientInfo, McpTokenInfo } from './auth';
import { McpOAuthCallbackServer } from './oauth-callback';

const debug = createDebug('neovate:mcp:oauth');

/**
 * OAuth configuration for MCP servers
 */
export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
}

/**
 * OAuth provider for MCP servers
 * Implements OAuth 2.0 authorization code flow with PKCE
 */
export class McpOAuthProvider {
  private serverName: string;
  private serverUrl: string;
  private config: McpOAuthConfig;
  private auth: McpAuth;

  constructor(
    serverName: string,
    serverUrl: string,
    config: McpOAuthConfig,
    auth: McpAuth,
  ) {
    this.serverName = serverName;
    this.serverUrl = serverUrl;
    this.config = config;
    this.auth = auth;
  }

  /**
   * Get access token (from storage or refresh if expired)
   */
  async getAccessToken(): Promise<string | undefined> {
    const token = this.auth.getToken(this.serverName);

    if (!token) {
      debug(`No token found for ${this.serverName}`);
      return undefined;
    }

    // Check if token is expired
    if (this.auth.isTokenExpired(this.serverName)) {
      debug(`Token expired for ${this.serverName}, attempting refresh`);

      if (token.refreshToken) {
        try {
          const newToken = await this.refreshToken(token.refreshToken);
          this.auth.saveToken(this.serverName, newToken);
          return newToken.accessToken;
        } catch (error) {
          debug(`Token refresh failed: ${error}`);
          return undefined;
        }
      }

      debug(`No refresh token available for ${this.serverName}`);
      return undefined;
    }

    return token.accessToken;
  }

  /**
   * Check if OAuth is configured for this server
   */
  hasOAuthConfig(): boolean {
    return !!(this.config.clientId || this.config.registrationEndpoint);
  }

  /**
   * Check if client is registered
   */
  hasClientRegistration(): boolean {
    const client = this.auth.getClient(this.serverName);
    return !!client?.clientId;
  }

  /**
   * Register OAuth client dynamically (RFC 7591)
   */
  async registerClient(): Promise<McpClientInfo> {
    const registrationEndpoint =
      this.config.registrationEndpoint || `${this.serverUrl}/oauth/register`;

    debug(`Registering OAuth client at ${registrationEndpoint}`);

    try {
      const response = await fetch(registrationEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_name: `Neovate Code - ${this.serverName}`,
          redirect_uris: [McpOAuthCallbackServer.getCallbackUrl()],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'client_secret_basic',
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Client registration failed: ${error}`);
      }

      const data = await response.json();

      const clientInfo: McpClientInfo = {
        clientId: data.client_id,
        clientSecret: data.client_secret,
        registrationAccessToken: data.registration_access_token,
      };

      this.auth.saveClient(this.serverName, clientInfo);
      debug(`Client registered successfully for ${this.serverName}`);

      return clientInfo;
    } catch (error) {
      debug(`Client registration error: ${error}`);
      throw new Error(`Failed to register OAuth client: ${error}`);
    }
  }

  /**
   * Get authorization URL for OAuth flow
   */
  async getAuthorizationUrl(
    state: string,
    codeVerifier: string,
  ): Promise<string> {
    // Ensure we have client credentials
    let clientId = this.config.clientId;

    if (!clientId) {
      const client = this.auth.getClient(this.serverName);
      if (!client) {
        // Try to register client
        const newClient = await this.registerClient();
        clientId = newClient.clientId;
      } else {
        clientId = client.clientId;
      }
    }

    // Generate code challenge from verifier (PKCE)
    const codeChallenge = await this.generateCodeChallenge(codeVerifier);

    const authEndpoint =
      this.config.authorizationEndpoint || `${this.serverUrl}/oauth/authorize`;

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: McpOAuthCallbackServer.getCallbackUrl(),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    if (this.config.scope) {
      params.set('scope', this.config.scope);
    }

    const url = `${authEndpoint}?${params.toString()}`;
    debug(`Authorization URL generated for ${this.serverName}`);

    return url;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(
    code: string,
    codeVerifier: string,
  ): Promise<McpTokenInfo> {
    const tokenEndpoint =
      this.config.tokenEndpoint || `${this.serverUrl}/oauth/token`;

    let clientId = this.config.clientId;
    let clientSecret = this.config.clientSecret;

    if (!clientId) {
      const client = this.auth.getClient(this.serverName);
      if (!client) {
        throw new Error('No client credentials available');
      }
      clientId = client.clientId;
      clientSecret = client.clientSecret;
    }

    debug(`Exchanging code for token at ${tokenEndpoint}`);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: McpOAuthCallbackServer.getCallbackUrl(),
      code_verifier: codeVerifier,
      client_id: clientId,
    });

    const headers: HeadersInit = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    // Add client authentication if secret is available
    if (clientSecret) {
      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString(
        'base64',
      );
      headers.Authorization = `Basic ${auth}`;
    }

    try {
      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers,
        body,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
      }

      const data = await response.json();

      const token: McpTokenInfo = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        tokenType: data.token_type || 'Bearer',
        scope: data.scope,
        expiresAt: data.expires_in
          ? Date.now() + data.expires_in * 1000
          : undefined,
      };

      this.auth.saveToken(this.serverName, token);
      debug(`Token obtained successfully for ${this.serverName}`);

      return token;
    } catch (error) {
      debug(`Token exchange error: ${error}`);
      throw new Error(`Failed to exchange authorization code: ${error}`);
    }
  }

  /**
   * Refresh access token
   */
  private async refreshToken(refreshToken: string): Promise<McpTokenInfo> {
    const tokenEndpoint =
      this.config.tokenEndpoint || `${this.serverUrl}/oauth/token`;

    let clientId = this.config.clientId;
    let clientSecret = this.config.clientSecret;

    if (!clientId) {
      const client = this.auth.getClient(this.serverName);
      if (!client) {
        throw new Error('No client credentials available');
      }
      clientId = client.clientId;
      clientSecret = client.clientSecret;
    }

    debug(`Refreshing token for ${this.serverName}`);

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    });

    const headers: HeadersInit = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    if (clientSecret) {
      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString(
        'base64',
      );
      headers.Authorization = `Basic ${auth}`;
    }

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${error}`);
    }

    const data = await response.json();

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      tokenType: data.token_type || 'Bearer',
      scope: data.scope,
      expiresAt: data.expires_in
        ? Date.now() + data.expires_in * 1000
        : undefined,
    };
  }

  /**
   * Generate PKCE code challenge from verifier
   */
  private async generateCodeChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashBase64 = Buffer.from(hashArray).toString('base64');

    // Base64 URL encode
    return hashBase64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  /**
   * Generate random code verifier for PKCE
   */
  static generateCodeVerifier(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Buffer.from(array)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }

  /**
   * Generate random state for CSRF protection
   */
  static generateState(): string {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Buffer.from(array).toString('hex');
  }
}
