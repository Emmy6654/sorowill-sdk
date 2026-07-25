import freighterApi from '@stellar/freighter-api';

/** Result of a successful {@link connectWallet} call. */
export interface WalletConnection {
  publicKey: string;
  network: string;
  networkPassphrase: string;
}

/**
 * The minimal capability set a Stellar wallet must expose for
 * {@link SoroWillClient} to read the connected account and sign transactions.
 *
 * Any wallet — Freighter, Albedo, xBull, Rabet, Lobstr, etc. — can be plugged
 * into the client by implementing this interface. The module-level
 * {@link getPublicKey} and {@link signTransaction} functions already satisfy
 * it (see {@link freighterAdapter}).
 */
export interface WalletAdapter {
  /**
   * Returns the connected account's public key (`G...`). May prompt the user
   * to select or connect an account, depending on the wallet.
   */
  getPublicKey(): Promise<string>;
  /**
   * Signs a base64-encoded transaction XDR envelope for the given network and
   * resolves with the signed XDR.
   */
  signTransaction(
    transactionXdr: string,
    opts: { networkPassphrase: string },
  ): Promise<string>;
}

/**
 * Checks whether the Freighter browser extension is installed. This does not
 * require the current site to be connected/allowed — it only checks for the
 * extension's presence.
 */
export async function isFreighterInstalled(): Promise<boolean> {
  const { isConnected, error } = await freighterApi.isConnected();
  if (error) {
    return false;
  }
  return isConnected;
}

/**
 * Requests the user to connect their Freighter wallet to this site, and
 * returns the connected public key and the wallet's currently selected
 * network.
 *
 * @throws if Freighter is not installed, the user declines access, or the
 * network details cannot be read.
 */
export async function connectWallet(): Promise<WalletConnection> {
  const access = await freighterApi.requestAccess();
  if (access.error) {
    throw new Error(access.error.message);
  }

  const networkDetails = await freighterApi.getNetworkDetails();
  if (networkDetails.error) {
    throw new Error(networkDetails.error.message);
  }

  return {
    publicKey: access.address,
    network: networkDetails.network,
    networkPassphrase: networkDetails.networkPassphrase,
  };
}

/**
 * Reads the currently connected Freighter public key, without prompting the
 * user. Call {@link connectWallet} first to establish a connection.
 *
 * @throws if Freighter is not installed or no account is connected.
 */
export async function getPublicKey(): Promise<string> {
  const { address, error } = await freighterApi.getAddress();
  if (error) {
    throw new Error(error.message);
  }
  if (!address) {
    throw new Error('No Freighter account is connected. Call connectWallet() first.');
  }
  return address;
}

/**
 * Asks Freighter to sign a transaction XDR envelope with the currently
 * connected account, returning the signed transaction XDR.
 *
 * @throws if the user declines to sign or Freighter reports an error.
 */
export async function signTransaction(
  transactionXdr: string,
  opts: { networkPassphrase: string },
): Promise<string> {
  const { signedTxXdr, error } = await freighterApi.signTransaction(transactionXdr, {
    networkPassphrase: opts.networkPassphrase,
  });
  if (error) {
    throw new Error(error.message);
  }
  return signedTxXdr;
}

/**
 * The default {@link WalletAdapter}, backed by the Freighter browser
 * extension. This is what {@link SoroWillClient} uses when no `wallet` option
 * is supplied, so existing Freighter-based usage keeps working unchanged.
 */
export const freighterAdapter: WalletAdapter = {
  getPublicKey,
  signTransaction,
};
