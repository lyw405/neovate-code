import createDebug from 'debug';
import * as http from 'http';
import type { McpOAuthProvider } from './oauth-provider';

const debug = createDebug('neovate:mcp:oauth:callback');

export interface OAuthCallbackData {
  code: string;
  state: string;
}

/**
 * Local HTTP server for handling OAuth callbacks
 */
export class McpOAuthCallbackServer {
  private static readonly PORT = 19876;
  private static readonly HOST = 'localhost';

  private server: http.Server | null = null;
  private pendingCallbacks: Map<
    string,
    {
      provider: McpOAuthProvider;
      codeVerifier: string;
      resolve: (value: boolean) => void;
      reject: (error: Error) => void;
    }
  > = new Map();

  /**
   * Start the callback server
   */
  async start(): Promise<void> {
    if (this.server) {
      debug('Callback server already running');
      return;
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer(this.handleRequest.bind(this));

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          debug(
            `Port ${McpOAuthCallbackServer.PORT} already in use, assuming server is already running`,
          );
          // Port already in use, assume another instance is running
          this.server = null;
          resolve();
        } else {
          reject(error);
        }
      });

      this.server.listen(
        McpOAuthCallbackServer.PORT,
        McpOAuthCallbackServer.HOST,
        () => {
          debug(
            `OAuth callback server listening on http://${McpOAuthCallbackServer.HOST}:${McpOAuthCallbackServer.PORT}`,
          );
          resolve();
        },
      );
    });
  }

  /**
   * Stop the callback server
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    return new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          debug('OAuth callback server stopped');
          this.server = null;
          resolve();
        }
      });
    });
  }

  /**
   * Register a pending OAuth flow
   */
  registerCallback(
    state: string,
    provider: McpOAuthProvider,
    codeVerifier: string,
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.pendingCallbacks.set(state, {
        provider,
        codeVerifier,
        resolve,
        reject,
      });

      // Timeout after 5 minutes
      setTimeout(
        () => {
          if (this.pendingCallbacks.has(state)) {
            this.pendingCallbacks.delete(state);
            reject(new Error('OAuth flow timed out'));
          }
        },
        5 * 60 * 1000,
      );
    });
  }

  /**
   * Handle incoming HTTP requests
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!req.url || !req.headers.host) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request');
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    debug(`Received request: ${url.pathname}`);

    if (url.pathname === '/callback') {
      await this.handleOAuthCallback(url, res);
    } else if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }

  /**
   * Handle OAuth callback
   */
  private async handleOAuthCallback(
    url: URL,
    res: http.ServerResponse,
  ): Promise<void> {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    // Handle error response
    if (error) {
      debug(`OAuth error: ${error} - ${errorDescription}`);

      const pending = this.pendingCallbacks.get(state || '');
      if (pending && state) {
        this.pendingCallbacks.delete(state);
        pending.reject(
          new Error(`OAuth error: ${error} - ${errorDescription}`),
        );
      }

      this.sendHtmlResponse(
        res,
        400,
        'Authentication Failed',
        `
        <p>Authentication failed: ${error}</p>
        <p>${errorDescription || ''}</p>
        <p>You can close this window.</p>
      `,
      );
      return;
    }

    // Validate parameters
    if (!code || !state) {
      debug('Missing code or state parameter');
      this.sendHtmlResponse(
        res,
        400,
        'Invalid Request',
        `
        <p>Missing required parameters.</p>
        <p>You can close this window.</p>
      `,
      );
      return;
    }

    // Find pending callback
    const pending = this.pendingCallbacks.get(state);
    if (!pending) {
      debug(`No pending callback found for state: ${state}`);
      this.sendHtmlResponse(
        res,
        400,
        'Invalid State',
        `
        <p>Invalid or expired authentication request.</p>
        <p>You can close this window.</p>
      `,
      );
      return;
    }

    // Exchange code for token
    try {
      debug(`Exchanging code for token, state: ${state}`);
      await pending.provider.exchangeCodeForToken(code, pending.codeVerifier);

      this.pendingCallbacks.delete(state);
      pending.resolve(true);

      this.sendHtmlResponse(
        res,
        200,
        'Authentication Successful',
        `
        <p>✓ Authentication successful!</p>
        <p>You can now close this window and return to Neovate Code.</p>
        <script>
          setTimeout(function() {
            window.close();
          }, 3000);
        </script>
      `,
      );
    } catch (error) {
      debug(`Token exchange failed: ${error}`);

      this.pendingCallbacks.delete(state);
      pending.reject(error instanceof Error ? error : new Error(String(error)));

      this.sendHtmlResponse(
        res,
        500,
        'Authentication Failed',
        `
        <p>Failed to complete authentication.</p>
        <p>${error instanceof Error ? error.message : String(error)}</p>
        <p>You can close this window.</p>
      `,
      );
    }
  }

  /**
   * Send HTML response
   */
  private sendHtmlResponse(
    res: http.ServerResponse,
    statusCode: number,
    title: string,
    body: string,
  ): void {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #333;
    }
    .container {
      background: white;
      padding: 3rem;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 500px;
      text-align: center;
    }
    h1 {
      color: #667eea;
      margin-top: 0;
      font-size: 1.8rem;
    }
    p {
      line-height: 1.6;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    ${body}
  </div>
</body>
</html>
    `;

    res.writeHead(statusCode, { 'Content-Type': 'text/html' });
    res.end(html);
  }

  /**
   * Get callback URL
   */
  static getCallbackUrl(): string {
    return `http://${McpOAuthCallbackServer.HOST}:${McpOAuthCallbackServer.PORT}/callback`;
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.server !== null;
  }
}

// Global singleton instance
let globalCallbackServer: McpOAuthCallbackServer | null = null;

/**
 * Get or create the global callback server instance
 */
export function getGlobalCallbackServer(): McpOAuthCallbackServer {
  if (!globalCallbackServer) {
    globalCallbackServer = new McpOAuthCallbackServer();
  }
  return globalCallbackServer;
}
