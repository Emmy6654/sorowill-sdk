/** Network details returned when a wallet session is established. */
export interface WalletConnection {
  publicKey: string;
  network: string;
  networkPassphrase: string;
}

/** Options shared by wallet transaction signing implementations. */
export interface SignTransactionOptions {
  networkPassphrase: string;
}

/**
 * Common interface implemented by every wallet supported by the SDK.
 *
 * Adapters intentionally return signed XDR rather than submitting a
 * transaction, leaving simulation, submission, and retry policy to callers.
 */
export interface WalletAdapter {
  readonly id: string;
  readonly name: string;
  connect(): Promise<WalletConnection>;
  disconnect(): Promise<void>;
  isConnected(): Promise<boolean>;
  getPublicKey(): Promise<string>;
  signTransaction(transactionXdr: string, options: SignTransactionOptions): Promise<string>;
}

