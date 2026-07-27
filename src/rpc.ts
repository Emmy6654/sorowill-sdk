import { rpc } from '@stellar/stellar-sdk';

export function isRetryableRpcConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return [
    'fetch failed',
    'network error',
    'failed to fetch',
    'econnrefused',
    'etimedout',
    'timeout',
    'socket hang up',
    'enotfound',
    'econnreset',
    'connect',
  ].some((fragment) => message.includes(fragment));
}

export class RpcEndpointPool {
  private readonly servers: rpc.Server[];
  private readonly rpcUrls: string[];
  private activeIndex = 0;

  constructor(rpcUrls: readonly string[]) {
    const normalizedRpcUrls = rpcUrls
      .map((rpcUrl) => rpcUrl.trim())
      .filter((rpcUrl) => rpcUrl.length > 0);

    if (normalizedRpcUrls.length === 0) {
      throw new Error('At least one RPC URL must be configured');
    }

    this.rpcUrls = normalizedRpcUrls;
    this.servers = normalizedRpcUrls.map(
      (rpcUrl) => new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') }),
    );
  }

  async withFailover<T>(operation: (server: rpc.Server, rpcUrl: string) => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.servers.length; attempt += 1) {
      const rpcUrl = this.rpcUrls[this.activeIndex];
      const server = this.servers[this.activeIndex];

      if (!rpcUrl || !server) {
        break;
      }

      try {
        return await operation(server, rpcUrl);
      } catch (error) {
        lastError = error;
        if (!isRetryableRpcConnectionError(error) || attempt === this.servers.length - 1) {
          throw error;
        }
        this.activeIndex = (this.activeIndex + 1) % this.servers.length;
      }
    }

    throw lastError ?? new Error('RPC failover exhausted every configured endpoint');
  }

  getActiveRpcUrl(): string {
    const rpcUrl = this.rpcUrls[this.activeIndex];
    if (!rpcUrl) {
      throw new Error('No active RPC URL is configured');
    }
    return rpcUrl;
  }
}
